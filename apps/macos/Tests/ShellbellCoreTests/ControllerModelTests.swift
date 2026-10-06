import Foundation
import XCTest

@testable import ShellbellCore

@MainActor final class FixtureConnection: ControllerConnection {
  var onEvent: ((JSONValue) -> Void)?
  var onClosed: (() -> Void)?
  var isReady = true
  var commands: [(String, JSONValue?)] = []
  var pending: ((Result<JSONValue, BridgeFailure>) -> Void)?
  var closed = false
  var holdHandshake = false
  func connect(_ completion: @escaping (Result<JSONValue, BridgeFailure>) -> Void) {
    if holdHandshake { pending = completion } else { completion(.success(.object([:]))) }
  }
  func request(
    _ command: String, args: JSONValue?,
    completion: @escaping (Result<JSONValue, BridgeFailure>) -> Void
  ) {
    XCTAssertNil(pending, "Bridge requests must never overlap")
    commands.append((command, args))
    pending = completion
  }
  func finish(_ result: Result<JSONValue, BridgeFailure>) {
    let callback = pending
    pending = nil
    callback?(result)
  }
  func close() {
    closed = true
    onClosed?()
  }
}

@MainActor final class ControllerModelTests: XCTestCase {
  func testPowerEligibilitySurvivesMetadataMutationButExpiresOrDisconnects() {
    let c = FixtureConnection()
    var time = Date(timeIntervalSince1970: 100)
    let model = ControllerModel(connection: c, now: { time })
    model.connect()
    c.finish(.success(desktopSnapshot()))
    XCTAssertTrue(model.powerEligibility(power: .ac, isLaptop: true).desktopServiceVerified)
    model.loadSettings()
    XCTAssertTrue(model.busy)
    XCTAssertFalse(model.canMutate)
    XCTAssertTrue(model.powerEligibility(power: .ac, isLaptop: true).desktopServiceVerified)
    XCTAssertTrue(model.powerEligibility(power: .ac, isLaptop: true).statusFresh)
    time = Date(timeIntervalSince1970: 111)
    XCTAssertFalse(model.powerEligibility(power: .ac, isLaptop: true).statusFresh)
    time = Date(timeIntervalSince1970: 99)
    XCTAssertFalse(model.powerEligibility(power: .ac, isLaptop: true).statusFresh)
    c.onClosed?()
    XCTAssertFalse(model.powerEligibility(power: .ac, isLaptop: true).desktopServiceVerified)
  }

  func testPowerEligibilityRequiresDesktopOwnershipAndMatchingLiveProcess() {
    for mode in ["headless", "desktop"] {
      let c = FixtureConnection()
      let model = ControllerModel(connection: c)
      var fields = desktopSnapshot().object!
      fields["selection"] = .object(["mode": .string(mode)])
      if mode == "desktop" {
        fields["desktop"] = .object(["loaded": .bool(true), "pid": .number(999)])
      }
      model.connect()
      c.finish(.success(.object(fields)))
      XCTAssertFalse(model.powerEligibility(power: .ac, isLaptop: true).desktopServiceVerified)
    }
  }

  static let runtime: JSONValue = .object([
    "pid": .number(101), "agentVersion": .string("0.0.0"),
    "computerFp": .string("aaaaaaaaaaaaaaaaaaaaaaaaaa"), "stateDir": .string("/fixture/state"),
    "serviceInstance": .null,
  ])
  static let snapshot: JSONValue = .object([
    "revision": .string("00000000-0000-4000-8000-000000000001"),
    "selection": .null, "transition": .null, "recoveryAvailable": .bool(false),
    "local": .object(["kind": .string("verified"), "status": .object(["process": runtime])]),
  ])
  func ready(_ c: FixtureConnection, _ m: ControllerModel) {
    m.connect()
    c.finish(.success(Self.snapshot))
  }
  private func desktopSnapshot(running: Bool = true, pending: Bool = false) -> JSONValue {
    var fields = Self.snapshot.object!
    fields["ownership"] = .object([
      "revision": .string("00000000-0000-4000-8000-000000000002"),
      "mode": .string("desktop"), "consented": .bool(true), "startupEnabled": .bool(true),
      "transition": pending ? .object(["id": .string("pending")]) : .null,
    ])
    fields["selection"] = .object(["mode": .string("desktop")])
    fields["desktop"] = .object(["loaded": .bool(running), "pid": running ? .number(101) : .null])
    if !running { fields["local"] = .object(["kind": .string("absent"), "status": .null]) }
    return .object(fields)
  }
  func testDesktopQuitKeepsAppOpenWhenVerifiedShutdownFails() {
    let c = FixtureConnection()
    let model = ControllerModel(connection: c)
    model.connect()
    c.finish(.success(desktopSnapshot()))
    var completed: Bool?
    model.quit { completed = $0 }
    XCTAssertEqual(c.commands.last?.0, "status")
    c.finish(.success(desktopSnapshot()))
    XCTAssertEqual(c.commands.last?.0, "desktop.stop")
    XCTAssertNil(completed)
    c.finish(.failure(.operationFailed))
    XCTAssertEqual(completed, false)
    XCTAssertFalse(c.closed)
    XCTAssertTrue(model.notice?.contains("shutdown") == true)
  }
  func testDesktopQuitVerifiesStopAndPreservesLoginPreference() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    m.connect()
    c.finish(.success(desktopSnapshot()))
    var completed: Bool?
    m.quit { completed = $0 }
    c.finish(.success(desktopSnapshot()))
    c.finish(.success(desktopSnapshot(running: false)))
    XCTAssertEqual(completed, true)
    XCTAssertTrue(c.closed)
    XCTAssertEqual(m.status["ownership"]["startupEnabled"], .bool(true))
    XCTAssertFalse(c.commands.map(\.0).contains("desktop.login.set"))
  }
  func testAppLaunchStartsConsentedDesktopOnceButWindowActivationDoesNot() {
    let c = FixtureConnection()
    let model = ControllerModel(connection: c)
    model.launchDesktopIfConsented()
    model.connect()
    c.finish(.success(desktopSnapshot(running: false)))
    XCTAssertEqual(c.commands.last?.0, "desktop.start")
    c.finish(.success(desktopSnapshot()))
    model.launchDesktopIfConsented()
    model.activateWindow("Settings")
    c.finish(.success(desktopSnapshot()))
    c.finish(.success(.object([:])))
    XCTAssertEqual(c.commands.filter { $0.0 == "desktop.start" }.count, 1)
  }
  func testPendingConversionNeverAutoStartsOnAppLaunch() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    m.launchDesktopIfConsented()
    m.connect()
    c.finish(.success(desktopSnapshot(running: false, pending: true)))
    XCTAssertEqual(c.commands.map(\.0), ["status"])
  }
  func testBackgroundRefreshKeepsControlsStableAndDoesNotDropAClick() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    m.connect()
    c.finish(.success(desktopSnapshot()))
    m.refreshInBackground()
    XCTAssertEqual(c.commands.count, 2)
    XCTAssertEqual(m.phase, .idle)
    m.setLoginStartup(false)
    XCTAssertEqual(c.commands.last?.0, "status")
    c.finish(.success(desktopSnapshot()))
    XCTAssertEqual(c.commands.last?.0, "desktop.login.set")
    XCTAssertEqual(c.commands.last?.1?["enabled"], .bool(false))
    XCTAssertEqual(c.commands.last?.1?["ownerRevision"], desktopSnapshot()["ownership"]["revision"])
    c.finish(.success(desktopSnapshot()))
  }
  func testHeadlessConversionSendsExplicitTargetConsentAndCurrentOwnerRevision() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    m.connect()
    c.finish(.success(desktopSnapshot()))
    m.convertOwnership(to: "headless")
    XCTAssertEqual(c.commands.last?.0, "ownership.convert")
    XCTAssertEqual(c.commands.last?.1?["target"], .string("headless"))
    XCTAssertEqual(c.commands.last?.1?["consent"], .bool(true))
    XCTAssertEqual(
      c.commands.last?.1?["ownerRevision"], .string("00000000-0000-4000-8000-000000000002"))
  }

  func testDesktopRestartStopsThenStartsWithoutChangingLoginPreference() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    m.connect()
    c.finish(.success(desktopSnapshot()))
    m.restart()
    XCTAssertEqual(c.commands.last?.0, "desktop.stop")
    c.finish(.success(desktopSnapshot(running: false)))
    XCTAssertEqual(c.commands.last?.0, "desktop.start")
    c.finish(.success(desktopSnapshot()))
    XCTAssertFalse(c.commands.map(\.0).contains("desktop.login.set"))
  }

  func testHeadlessSettingsNeverSendAnUnsupportedNativeRestart() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    var fields = desktopSnapshot().object!
    fields["ownership"] = .object(["mode": .string("headless"), "transition": .null])
    fields["selection"] = .null
    m.connect()
    c.finish(.success(.object(fields)))
    m.restart()
    XCTAssertEqual(c.commands.map(\.0), ["status"])
  }
  func testQueuedClickCannotApplyToChangedOwnershipAfterBackgroundRead() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    m.connect()
    c.finish(.success(desktopSnapshot()))
    m.refreshInBackground()
    m.setLoginStartup(false)
    var changed = desktopSnapshot().object!
    var owner = changed["ownership"]!.object!
    owner["revision"] = .string("00000000-0000-4000-8000-000000000003")
    changed["ownership"] = .object(owner)
    c.finish(.success(.object(changed)))
    XCTAssertEqual(c.commands.map(\.0), ["status", "status"])
    XCTAssertEqual(m.phase, .conflict)
  }
  func testHeadlessLaunchNeverStartsDesktopAndQuitLeavesServiceAlone() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    var state = desktopSnapshot().object!
    state["selection"] = .null
    state["ownership"] = .object([
      "mode": .string("headless"), "consented": .bool(true), "transition": .null,
    ])
    m.launchDesktopIfConsented()
    m.connect()
    c.finish(.success(.object(state)))
    var completed: Bool?
    m.quit { completed = $0 }
    XCTAssertEqual(completed, true)
    XCTAssertEqual(c.commands.map(\.0), ["status"])
  }
  func testStartupFailureRemainsActionableAcrossBackgroundRefresh() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.start(mode: "persistent")
    c.finish(.failure(.startupUnavailable))
    let notice = m.notice
    XCTAssertTrue(notice?.contains("automatic startup") == true)
    m.refresh()
    c.finish(.success(Self.snapshot))
    XCTAssertEqual(m.notice, notice)
    XCTAssertTrue(m.canMutate)
    XCTAssertEqual(c.commands.filter { $0.0 == "service.start" }.count, 1)
  }
  private func settings(_ revision: String, name: String) -> JSONValue {
    .object([
      "savedRevision": .string(revision),
      "saved": .object([
        "relayUrl": .string("wss://fixture.invalid"), "computerName": .string(name),
        "accent": .string("mint"), "notifyMinCommandMs": .number(100),
        "idleQuietMs": .number(200), "idleMinActiveMs": .number(300),
      ]),
    ])
  }
  func testReopenedEditorWaitsForSettingsAndDirtyDraftRetainsOwnBasisOnActivation() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.loadSettings()
    c.finish(.success(settings("A", name: "Alice")))
    var draft = SettingsDraft()
    m.activateWindow("Settings")
    // A cached emission during reopen cannot seed a fresh editor.
    draft.receive(m.settings, refreshing: m.busy)
    XCTAssertEqual(draft.revision, .null)
    c.finish(.success(Self.snapshot))
    c.finish(.success(settings("B", name: "Bob")))
    draft.receive(m.settings, refreshing: m.busy)
    XCTAssertEqual(draft.values["name"], "Bob")
    XCTAssertEqual(draft.revision, .string("B"))
    draft.values["name"] = "My edit"
    m.activateWindow("Settings")
    c.finish(.success(Self.snapshot))
    c.finish(.success(settings("C", name: "CLI edit")))
    draft.receive(m.settings, refreshing: m.busy)
    XCTAssertEqual(draft.values["name"], "My edit")
    XCTAssertEqual(draft.revision, .string("B"))
    m.saveSettings(changes: draft.values, revision: draft.revision)
    XCTAssertEqual(c.commands.last?.1?["configRevision"], .string("B"))
    c.finish(.failure(.conflict))
    XCTAssertEqual(m.phase, .conflict)
    XCTAssertEqual(draft.values["name"], "My edit")
    m.refreshSettings()
    c.finish(.success(Self.snapshot))
    XCTAssertFalse(m.canMutate)
    c.finish(.success(settings("C", name: "CLI edit")))
    XCTAssertTrue(m.canMutate)
    draft.receive(m.settings)
    XCTAssertEqual(draft.revision, .string("B"))
    // Only explicit discard replaces values and basis together.
    draft.replace(with: m.settings)
    XCTAssertEqual(draft.values["name"], "CLI edit")
    XCTAssertEqual(draft.revision, .string("C"))
    draft.values["name"] = "Saved edit"
    m.saveSettings(changes: draft.values, revision: draft.revision) { draft.replace(with: $0) }
    c.finish(.success(settings("D", name: "Saved edit")))
    XCTAssertEqual(draft.revision, .string("D"))
    XCTAssertEqual(draft.values["name"], "Saved edit")
    m.saveSettings(changes: draft.values, revision: draft.revision)
    XCTAssertEqual(c.commands.last?.1?["configRevision"], .string("D"))
  }
  func testSettingsConflictNeedsBothSettingsAndStatusDespiteUnrelatedReads() {
    for command in ["diagnostics", "devices", "settings.get"] {
      let c = FixtureConnection()
      let m = ControllerModel(connection: c)
      ready(c, m)
      m.saveSettings(changes: ["name": "mine"], revision: .string("A"))
      c.finish(.failure(.conflict))
      switch command {
      case "diagnostics": m.loadDiagnostics()
      case "devices": m.loadDevices()
      default: m.loadSettings()
      }
      c.finish(.success(settings("B", name: "external")))
      XCTAssertEqual(m.phase, .conflict, command)
      XCTAssertEqual(m.error, .conflict, command)
      m.refresh()
      c.finish(.success(Self.snapshot))
      if command != "settings.get" {
        XCTAssertFalse(m.canMutate, command)
        m.loadSettings()
        c.finish(.success(settings("B", name: "external")))
      }
      XCTAssertTrue(m.canMutate, command)
      XCTAssertNil(m.error)
    }
  }
  func testActivationRefreshesEachSurfaceAndNeverOpensPairing() {
    for (name, payload) in [
      ("Settings", "settings.get"), ("Devices", "devices"),
      ("Diagnostics", "diagnostics"), ("Pair Device", ""),
    ] {
      let c = FixtureConnection()
      let m = ControllerModel(connection: c)
      ready(c, m)
      m.activateWindow(name)
      XCTAssertEqual(c.commands.last?.0, "status")
      for _ in 0..<100 { m.activateWindow(name) }
      c.finish(.success(Self.snapshot))
      if !payload.isEmpty {
        XCTAssertEqual(c.commands.last?.0, payload)
        c.finish(.success(.object([:])))
      }
      XCTAssertNil(c.pending)
      XCTAssertEqual(
        c.commands.map(\.0),
        payload.isEmpty ? ["status", "status"] : ["status", "status", payload])
    }
  }
  func testHeadlessOpeningOnlyInspectsAndQuitNeverStopsService() {
    // Read-only startup must remain independent of the new settings window.
    // Opening remains read-only.
    let c = FixtureConnection()
    let model = ControllerModel(connection: c)
    ready(c, model)
    XCTAssertEqual(c.commands.map(\.0), ["status"])
    var quit = false
    model.quit { _ in quit = true }
    XCTAssertTrue(quit)
    XCTAssertTrue(c.closed)
    XCTAssertFalse(c.commands.map(\.0).contains("service.stop"))
    XCTAssertFalse(c.commands.map(\.0).contains("service.remove"))
  }

  func testAdvancedActivationLoadsSettingsAlongsideDiagnostics() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.activateWindow("Advanced")
    c.finish(.success(Self.snapshot))
    XCTAssertEqual(c.commands.last?.0, "settings.get")
    guard c.commands.last?.0 == "settings.get" else { return }
    c.finish(.success(settings("A", name: "My Mac")))
    XCTAssertEqual(c.commands.last?.0, "diagnostics")
    c.finish(.success(.object(["checks": .array([])])))
    XCTAssertEqual(m.settings["saved"]["computerName"], .string("My Mac"))
    XCTAssertNil(c.pending)
  }

  func testUnrelatedReadsPreserveConflictUntilStatusRefresh() {
    for command in ["diagnostics", "devices", "settings.get"] {
      let c = FixtureConnection()
      let m = ControllerModel(connection: c)
      ready(c, m)
      m.stop()
      c.finish(.failure(.conflict))
      switch command {
      case "diagnostics": m.loadDiagnostics()
      case "devices": m.loadDevices()
      default: m.loadSettings()
      }
      c.finish(.success(.object([:])))
      XCTAssertEqual(m.phase, .conflict, command)
      XCTAssertFalse(m.canMutate, command)
      m.refresh()
      c.finish(.success(Self.snapshot))
      XCTAssertTrue(m.canMutate)
    }
  }

  func testCachedDraftMustNotBorrowLaterSettingsRevision() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.loadSettings()
    c.finish(
      .success(
        .object([
          "savedRevision": .string("A"), "saved": .object(["computerName": .string("Alice")]),
        ])))
    let values = ["name": "Alice"]
    m.loadSettings()
    c.finish(
      .success(
        .object(["savedRevision": .string("B"), "saved": .object(["computerName": .string("Bob")])])
      ))
    m.saveSettings(changes: values, revision: .string("A"))
    XCTAssertEqual(c.commands.last?.1?["configRevision"], .string("A"))
  }

  func testActivationRefreshDefersAndCoalescesWhileMutationIsPending() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.stop()
    for _ in 0..<100 { m.refreshSettings() }
    XCTAssertEqual(c.commands.map(\.0), ["status", "service.stop"])
    c.finish(.success(Self.snapshot))
    XCTAssertEqual(c.commands.last?.0, "status")
    c.finish(.success(Self.snapshot))
    XCTAssertEqual(c.commands.last?.0, "settings.get")
    c.finish(.success(.object([:])))
    XCTAssertNil(c.pending)
    XCTAssertEqual(c.commands.map(\.0), ["status", "service.stop", "status", "settings.get"])
  }
  func testLifecycleUsesCurrentExpectationAndQuitWaitsForOutcome() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.start(mode: "persistent", migrateLegacy: true)
    XCTAssertEqual(c.commands.last?.0, "service.start")
    XCTAssertEqual(c.commands.last?.1?["expect"]["runtime"], Self.runtime)
    XCTAssertEqual(c.commands.last?.1?["migrateLegacy"], .bool(true))
    var quit = false
    m.quit { _ in quit = true }
    XCTAssertFalse(quit)
    XCTAssertFalse(c.closed)
    c.finish(.failure(.deliveryUnknown))
    XCTAssertTrue(quit)
    XCTAssertTrue(c.closed)
    XCTAssertEqual(c.commands.count, 2)
  }
  func testSettingsUnknownAndConflictRequireExplicitRefreshNoRestart() {
    let c = FixtureConnection()
    let model = ControllerModel(connection: c)
    ready(c, model)
    model.loadSettings()
    c.finish(
      .success(
        .object([
          "applied": .string("unknown"),
          "savedRevision": .string(String(repeating: "a", count: 64)),
        ])))
    XCTAssertEqual(model.settingsApplied, "unknown")
    model.saveSettings(changes: ["name": "Fixture"], revision: model.settings["savedRevision"])
    XCTAssertEqual(c.commands.last?.0, "settings.set")
    c.finish(.failure(.conflict))
    XCTAssertEqual(model.phase, .conflict)
    XCTAssertFalse(model.canMutate)
    XCTAssertFalse(c.commands.map(\.0).contains("service.restart"))
    model.restart()
    XCTAssertEqual(c.commands.count, 3)
    model.refresh()
    c.finish(.success(Self.snapshot))
    XCTAssertFalse(model.canMutate)
    model.loadSettings()
    c.finish(.success(.object(["savedRevision": .string(String(repeating: "b", count: 64))])))
    XCTAssertTrue(model.canMutate)
  }
  func testReplacementChallengeUpdatesConsentAndSurvivesEarlierAnswer() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.openPairing()
    c.finish(.success(.object([
      "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"), "qrText": .string("fixture"),
      "expiresAt": .number(9_000_000_000_000),
    ])))
    let first: JSONValue = .object([
      "event": .string("pairing.request"), "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"),
      "challengeId": .string("bbbbbbbbbbbbbbbbbbbbbb"),
      "phoneFp": .string("aaaaaaaaaaaaaaaaaaaaaaaaaa"), "name": .string("First"),
    ])
    c.onEvent?(first)
    m.confirmPairing(accept: true, challengeId: m.consent["challengeId"].string ?? "")
    var replacement = first.object!
    replacement["challengeId"] = .string("cccccccccccccccccccccc")
    replacement["name"] = .string("Retry")
    c.onEvent?(.object(replacement))
    XCTAssertEqual(m.consent, .object(replacement))
    c.finish(.success(.object([:])))
    XCTAssertEqual(m.consent, .object(replacement))
    XCTAssertFalse(c.closed)
    c.finish(.success(.array([]))) // Follow-up device list after confirmation.
    m.confirmPairing(accept: true, challengeId: m.consent["challengeId"].string ?? "")
    XCTAssertEqual(c.commands.last?.1?["challengeId"], replacement["challengeId"])
  }

  func testFailedPairingAnswerRecoversStatusAndClosesNormally() {
    for (failure, replacement) in [(BridgeFailure.operationFailed, false), (.operationFailed, true), (.busy, false)] {
      let c = FixtureConnection()
      let m = ControllerModel(connection: c)
      ready(c, m)
      m.openPairing()
      c.finish(.success(.object([
        "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"), "qrText": .string("fixture"),
        "expiresAt": .number(9_000_000_000_000),
      ])))
      let challenge: JSONValue = .object([
        "event": .string("pairing.request"), "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"),
        "challengeId": .string("bbbbbbbbbbbbbbbbbbbbbb"),
        "phoneFp": .string("aaaaaaaaaaaaaaaaaaaaaaaaaa"), "name": .string("Fixture"),
      ])
      c.onEvent?(challenge)
      m.confirmPairing(accept: true, challengeId: m.consent["challengeId"].string ?? "")
      var newer = challenge.object!
      newer["challengeId"] = .string("cccccccccccccccccccccc")
      if replacement { c.onEvent?(.object(newer)) }
      c.finish(.failure(failure))
      let expectedConsent: JSONValue = replacement ? .object(newer) : (failure == .busy ? challenge : .null)
      XCTAssertEqual(m.consent, expectedConsent)
      XCTAssertEqual(c.commands.last?.0, "status")
      c.finish(.success(Self.snapshot))
      XCTAssertTrue(m.serviceAvailable)
      m.closePairing()
      XCTAssertEqual(c.commands.last?.0, "pairing.close")
      XCTAssertFalse(c.closed)
      c.finish(.success(.object([:])))
      XCTAssertFalse(m.pairingOwned)
      XCTAssertFalse(c.closed)
    }
  }

  func testConfirmationRefreshesDevicesAndRevocationUsesFullFingerprint() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.openPairing()
    c.finish(
      .success(
        .object([
          "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"), "qrText": .string("fixture"),
          "expiresAt": .number(9_000_000_000_000),
        ])))
    c.onEvent?(
      .object([
        "event": .string("pairing.request"), "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"),
        "challengeId": .string("bbbbbbbbbbbbbbbbbbbbbb"),
        "phoneFp": .string("aaaaaaaaaaaaaaaaaaaaaaaaaa"), "name": .string("Fixture"),
      ]))
    m.confirmPairing(accept: true, challengeId: m.consent["challengeId"].string ?? "")
    XCTAssertEqual(c.commands.last?.1?["phoneFp"], .string("aaaaaaaaaaaaaaaaaaaaaaaaaa"))
    c.finish(.success(.object([:])))
    XCTAssertEqual(c.commands.last?.0, "devices")
    c.finish(.success(.array([])))
    m.revoke("aaaaaaaaaaaaaaaaaaaaaaaaaa")
    XCTAssertEqual(c.commands.last?.0, "devices.revoke")
    XCTAssertEqual(c.commands.last?.1?["phoneFp"], .string("aaaaaaaaaaaaaaaaaaaaaaaaaa"))
  }
  func testForeignConsentAndExpiredOrChangedRuntimeCannotConfirm() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c, now: { Date(timeIntervalSince1970: 100) })
    ready(c, m)
    m.openPairing()
    c.finish(
      .success(
        .object([
          "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"), "qrText": .string("fixture"),
          "expiresAt": .number(1),
        ])))
    c.onEvent?(
      .object([
        "event": .string("pairing.request"), "flowId": .string("cccccccccccccccccccccc"),
        "phoneFp": .string("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
      ]))
    XCTAssertEqual(m.consent, .null)
    m.confirmPairing(accept: true, challengeId: m.consent["challengeId"].string ?? "")
    XCTAssertEqual(c.commands.count, 2)
    m.tick()
    XCTAssertEqual(m.pairing, .null)
  }
  func testReadOnlyWindowsDoNotDismissApprovalOrRecoveryState() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    m.connect()
    var snapshot = Self.snapshot.object!
    snapshot["transition"] = .object(["phase": .string("awaiting-approval")])
    c.finish(.success(.object(snapshot)))
    XCTAssertEqual(m.phase, .approval)
    m.loadDiagnostics()
    c.finish(.success(.object(["checks": .array([])])))
    XCTAssertEqual(m.phase, .approval)
    XCTAssertFalse(m.canMutate)
  }
  func testClosingPairWindowWhileOpenPendingClosesOnlyItsReturnedFlow() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.openPairing()
    m.closePairing()
    c.finish(
      .success(
        .object([
          "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"), "qrText": .string("fixture"),
          "expiresAt": .number(9_000_000_000_000),
        ])))
    XCTAssertEqual(c.commands.last?.0, "pairing.close")
    XCTAssertEqual(c.commands.last?.1?["flowId"], .string("aaaaaaaaaaaaaaaaaaaaaa"))
  }
  func testReloadSettingsFirstRefreshesExpectedRuntimeThenFetchesSavedRevision() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.refreshSettings()
    XCTAssertEqual(c.commands.last?.0, "status")
    c.finish(.success(Self.snapshot))
    XCTAssertEqual(c.commands.last?.0, "settings.get")
  }
  func testChangedRuntimeClearsConsentAndDisconnectsTheOwningClient() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.openPairing()
    c.finish(
      .success(
        .object([
          "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"), "qrText": .string("fixture"),
          "expiresAt": .number(9_000_000_000_000),
        ])))
    m.refresh()
    var changed = Self.snapshot.object!
    var owner = Self.runtime.object!
    owner["pid"] = .number(102)
    changed["local"] = .object([
      "kind": .string("verified"), "status": .object(["process": .object(owner)]),
    ])
    c.finish(.success(.object(changed)))
    XCTAssertEqual(m.pairing, .null)
    XCTAssertTrue(c.closed)
    XCTAssertEqual(m.phase, .unavailable)
  }
  func testQuitDuringHandshakeDoesNotQueueStatusOrHang() {
    let c = FixtureConnection()
    c.holdHandshake = true
    let m = ControllerModel(connection: c)
    m.connect()
    var quit = false
    m.quit { _ in quit = true }
    XCTAssertFalse(quit)
    c.finish(.success(.object([:])))
    XCTAssertTrue(quit)
    XCTAssertTrue(c.closed)
    XCTAssertTrue(c.commands.isEmpty)
  }
  func testClosingDuringConfirmationStillRefreshesDevicesAfterOwnedClose() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.openPairing()
    c.finish(
      .success(
        .object([
          "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"), "qrText": .string("fixture"),
          "expiresAt": .number(9_000_000_000_000),
        ])))
    c.onEvent?(
      .object([
        "event": .string("pairing.request"), "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"),
        "challengeId": .string("bbbbbbbbbbbbbbbbbbbbbb"),
        "phoneFp": .string("aaaaaaaaaaaaaaaaaaaaaaaaaa"), "name": .string("Fixture"),
      ]))
    m.confirmPairing(accept: true, challengeId: m.consent["challengeId"].string ?? "")
    m.closePairing()
    c.finish(.success(.object([:])))
    XCTAssertEqual(c.commands.last?.0, "pairing.close")
    c.finish(.success(.object([:])))
    XCTAssertEqual(c.commands.last?.0, "devices")
  }
  private func openOwnedPairing(_ c: FixtureConnection, _ m: ControllerModel) {
    ready(c, m)
    m.openPairing()
    c.finish(
      .success(
        .object([
          "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"), "qrText": .string("fixture"),
          "expiresAt": .number(9_000_000_000_000),
        ])))
  }
  func testClosingOwnedPairingDisconnectsWhenObservationRequiresAttention() {
    for error in [BridgeFailure.conflict, .approvalRequired, .recoveryRequired, .unavailable] {
      let c = FixtureConnection()
      let m = ControllerModel(connection: c)
      openOwnedPairing(c, m)
      m.loadDiagnostics()
      c.finish(.failure(error))
      XCTAssertTrue(m.pairingOwned)
      m.closePairing()
      XCTAssertTrue(c.closed, error.rawValue)
      XCTAssertFalse(m.pairingOwned, error.rawValue)
      XCTAssertEqual(c.commands.map(\.0), ["status", "pairing.open", "diagnostics"])
    }
  }
  func testDeferredWindowCloseDisconnectsAfterPendingObservationFails() {
    for error in [
      BridgeFailure.conflict, .approvalRequired, .recoveryRequired, .unavailable, .deliveryUnknown,
    ] {
      let c = FixtureConnection()
      let m = ControllerModel(connection: c)
      openOwnedPairing(c, m)
      m.refresh()
      m.closePairing()
      XCTAssertFalse(c.closed)
      c.finish(.failure(error))
      XCTAssertTrue(c.closed, error.rawValue)
      XCTAssertFalse(m.pairingOwned, error.rawValue)
      XCTAssertEqual(c.commands.map(\.0), ["status", "pairing.open", "status"])
    }
  }
  func testDeferredWindowCloseDisconnectsAfterPendingOpenFails() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    ready(c, m)
    m.openPairing()
    m.closePairing()
    c.finish(.failure(.conflict))
    XCTAssertTrue(c.closed)
    XCTAssertFalse(m.pairingOwned)
    XCTAssertEqual(c.commands.map(\.0), ["status", "pairing.open"])
  }
  func testDeferredWindowCloseDisconnectsAfterPendingConfirmationFails() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    openOwnedPairing(c, m)
    c.onEvent?(
      .object([
        "event": .string("pairing.request"), "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"),
        "challengeId": .string("bbbbbbbbbbbbbbbbbbbbbb"),
        "phoneFp": .string("aaaaaaaaaaaaaaaaaaaaaaaaaa"), "name": .string("Fixture"),
      ]))
    m.confirmPairing(accept: true, challengeId: m.consent["challengeId"].string ?? "")
    m.closePairing()
    c.finish(.failure(.conflict))
    XCTAssertTrue(c.closed)
    XCTAssertFalse(m.pairingOwned)
    XCTAssertEqual(c.commands.map(\.0), ["status", "pairing.open", "pairing.confirm"])
  }
  func testFailedOwnedCloseDisconnectsWithoutRetryingMutation() {
    let c = FixtureConnection()
    let m = ControllerModel(connection: c)
    openOwnedPairing(c, m)
    m.closePairing()
    XCTAssertEqual(c.commands.last?.0, "pairing.close")
    c.finish(.failure(.conflict))
    XCTAssertTrue(c.closed)
    XCTAssertFalse(m.pairingOwned)
    XCTAssertEqual(c.commands.filter { $0.0 == "pairing.close" }.count, 1)
  }
}
