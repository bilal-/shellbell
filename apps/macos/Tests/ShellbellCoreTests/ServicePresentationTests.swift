import XCTest

@testable import ShellbellCore

final class ServicePresentationTests: XCTestCase {
  func testFirstDesktopLoginRegistrationIsAvailableButUnknownStatusIsNot() {
    var state = snapshot().object!
    state["ownership"] = .object(["mode": .string("desktop"), "transition": .null])
    state["desktopLogin"] = .string("not-found")
    XCTAssertFalse(ServiceControls(status: .object(state)).automaticStartupUnavailable)
    state["desktopLogin"] = .string("unknown")
    XCTAssertTrue(ServiceControls(status: .object(state)).automaticStartupUnavailable)
    state.removeValue(forKey: "desktopLogin")
    XCTAssertTrue(ServiceControls(status: .object(state)).automaticStartupUnavailable)
  }

  func testHeadlessAndLegacyInstallationsDoNotExposeDesktopStartStop() {
    var legacy = snapshot(loaded: true, pid: 101, kind: "verified", localPID: 101).object!
    legacy["ownership"] = .object(["mode": .string("headless"), "transition": .null])
    XCTAssertNil(ServiceControls(status: .object(legacy)).action)
    legacy["ownership"] = .object(["mode": .string("legacy-native"), "transition": .null])
    XCTAssertNil(ServiceControls(status: .object(legacy)).action)
  }
  func testDesktopServiceAndLoginApprovalAreIndependent() {
    var state = snapshot(loaded: false, kind: "verified", localPID: 101).object!
    state["selection"] = .object(["mode": .string("desktop")])
    state["ownership"] = .object(["mode": .string("desktop"), "transition": .null])
    state["desktop"] = .object(["loaded": .bool(true), "pid": .number(101)])
    state["desktopLogin"] = .string("requires-approval")
    XCTAssertEqual(ServiceControls(status: .object(state)).action, .stop)
    XCTAssertEqual(ServicePresentation(status: .object(state)).processState, .runningVerified)
  }
  func testManualRecoveryIsOnlyOfferedForAnAbsentFailedPersistentDestination() {
    let status: JSONValue = .object([
      "selection": .object(["mode": .string("persistent")]),
      "manualRecoveryAvailable": .bool(true),
      "transition": .object(["action": .string("start"), "phase": .string("recovery-required")]),
      "manual": .object(["loaded": .bool(false)]),
      "persistent": .object(["loaded": .bool(false), "registration": .string("not-found")]),
      "legacy": .object(["installed": .bool(false), "loaded": .bool(false)]),
      "local": .object(["kind": .string("absent")]),
    ])
    XCTAssertTrue(ServiceControls(status: status).canRecoverManually)
    XCTAssertTrue(ServiceControls(status: status).automaticStartupUnavailable)
    XCTAssertFalse(ServiceControls(status: .null).canRecoverManually)
    XCTAssertFalse(ServiceControls(status: snapshot()).canRecoverManually)
    if case .object(var unavailable) = status {
      unavailable["manualRecoveryAvailable"] = .bool(false)
      XCTAssertFalse(ServiceControls(status: .object(unavailable)).canRecoverManually)
    }
  }
  private func desktopSnapshot(
    loaded: Bool = true, kind: String = "absent", pid: Double? = nil, localPID: Double? = nil
  ) -> JSONValue {
    var state = snapshot(loaded: false, kind: kind, localPID: localPID).object!
    state["ownership"] = .object(["mode": .string("desktop"), "transition": .null])
    state["selection"] = .object(["mode": .string("desktop")])
    state["desktop"] = .object(["loaded": .bool(loaded), "pid": pid.map(JSONValue.number) ?? .null])
    return .object(state)
  }
  func testSimpleControlsNeverOfferStartForAnObservedRunningJob() {
    let running = ServiceControls(
      status: desktopSnapshot(kind: "verified", pid: 101, localPID: 101))
    XCTAssertEqual(running.action, .stop)
    XCTAssertEqual(running.title, "Service running · relay offline")
    let foreign = ServiceControls(status: desktopSnapshot(kind: "foreign", pid: 101, localPID: 102))
    XCTAssertNil(foreign.action)
    XCTAssertEqual(foreign.title, "Service needs attention")
  }
  func testSimpleControlsDistinguishStoppedFromUnknown() {
    XCTAssertEqual(ServiceControls(status: desktopSnapshot(loaded: false)).action, .start)
    XCTAssertEqual(ServiceControls(status: desktopSnapshot(loaded: false)).startMode, "desktop")
    XCTAssertNil(ServiceControls(status: .null).action)
  }

  func testHeadlessConversionRequiresAnEstablishedDesktopWithoutPendingRecovery() {
    var state = desktopSnapshot(loaded: false).object!
    state["transition"] = .null
    XCTAssertTrue(ServiceControls(status: .object(state)).canConvertToHeadless)
    state["ownership"] = .object(["mode": .string("desktop"), "transition": .object([:])])
    XCTAssertFalse(ServiceControls(status: .object(state)).canConvertToHeadless)
    state["ownership"] = .object(["mode": .string("headless"), "transition": .null])
    XCTAssertFalse(ServiceControls(status: .object(state)).canConvertToHeadless)
    XCTAssertFalse(ServiceControls(status: .null).canConvertToHeadless)
  }
  func testBackgroundReadRefreshDoesNotPresentBusyNotice() {
    for command in ["status", "settings.get", "devices", "diagnostics"] {
      XCTAssertNil(ControllerPhase.busy(command).notice)
    }
    XCTAssertNotNil(ControllerPhase.busy("service.restart").notice)
    XCTAssertNotNil(ControllerPhase.recovery.notice)
  }
  func testPersistentConsentExplainsImmediateAndFutureStartupForStartAndMigration() {
    for migrate in [false, true] {
      let detail = StartConsent.detail(mode: "persistent", migrateLegacy: migrate)
      XCTAssertTrue(detail.contains("start now"))
      XCTAssertTrue(detail.contains("future logins"))
      XCTAssertTrue(detail.contains("approval"))
      if migrate { XCTAssertTrue(detail.contains("preserves its devices and identity")) }
    }
  }
  private func snapshot(
    registration: String = "enabled", loaded: Bool = true, pid: Double? = nil,
    kind: String = "absent", localPID: Double? = nil
  ) -> JSONValue {
    .object([
      "selection": .object(["mode": .string("persistent")]),
      "manual": .object([
        "registration": .string("not-registered"), "loaded": .bool(false), "pid": .null,
      ]),
      "persistent": .object([
        "registration": .string(registration), "loaded": .bool(loaded),
        "pid": pid.map(JSONValue.number) ?? .null,
      ]),
      "local": .object([
        "kind": .string(kind),
        "status": localPID.map { .object(["process": .object(["pid": .number($0)])]) } ?? .null,
      ]),
    ])
  }
  func testLoadedWithoutPIDIsNotPresentedAsRunning() {
    let presentation = ServicePresentation(status: snapshot())
    XCTAssertEqual(presentation.processState, .noObservedProcess)
    XCTAssertEqual(presentation.process, "Service process: Loaded job; no PID reported")
    XCTAssertTrue(presentation.managerRows.contains("At login manager: Registered, loaded"))
    XCTAssertEqual(presentation.ownership, "Local ownership: No local connection")
  }
  func testApprovalAndProcessObservationAreSeparate() {
    let presentation = ServicePresentation(
      status: snapshot(registration: "requires-approval", loaded: false))
    XCTAssertTrue(
      presentation.managerRows.contains("At login manager: Approval required, not loaded"))
    XCTAssertEqual(presentation.processState, .noObservedProcess)
    XCTAssertEqual(presentation.process, "Service process: No PID observed")
  }
  func testObservedPIDWithoutVerifiedEndpointIsDistinctFromVerifiedRunning() {
    let unverified = ServicePresentation(status: snapshot(pid: 101, kind: "unverified"))
    XCTAssertEqual(unverified.processState, .runningUnverified)
    XCTAssertEqual(
      unverified.process, "Service process: Observed PID 101 (at login); ownership unverified")
    XCTAssertEqual(unverified.ownership, "Local ownership: Unverified")
    let verified = ServicePresentation(status: snapshot(pid: 101, kind: "verified", localPID: 101))
    XCTAssertEqual(verified.processState, .runningVerified)
    XCTAssertEqual(verified.process, "Service process: Running, PID 101 (at login)")
    XCTAssertEqual(verified.ownership, "Local ownership: Verified owner, PID 101")
  }
  func testDifferentManagerAndLocalPIDsDoNotClaimVerifiedRunning() {
    let presentation = ServicePresentation(
      status: snapshot(pid: 101, kind: "verified", localPID: 102))
    XCTAssertEqual(presentation.processState, .runningUnverified)
    XCTAssertEqual(presentation.ownership, "Local ownership: Verified owner, PID 102")
  }
}
