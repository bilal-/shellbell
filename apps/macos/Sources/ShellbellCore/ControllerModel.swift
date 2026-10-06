import Combine
import Foundation

public enum ControllerPhase: Equatable, Sendable {
  case idle
  case busy(String)
  case approval, conflict, unavailable, unknownDelivery, recovery
}

@MainActor public final class ControllerModel: ObservableObject {
  @Published public private(set) var phase: ControllerPhase = .unavailable
  @Published public private(set) var status: JSONValue = .null
  @Published public private(set) var settings: JSONValue = .null
  @Published public private(set) var devices: [JSONValue] = []
  @Published public private(set) var diagnostics: [JSONValue] = []
  @Published public private(set) var pairing: JSONValue = .null
  @Published public private(set) var consent: JSONValue = .null
  @Published public private(set) var lastRefresh: Date?
  @Published public private(set) var error: BridgeFailure?
  @Published public private(set) var serviceError: BridgeFailure?
  @Published public private(set) var quitFailed = false
  public var notice: String? {
    if quitFailed {
      return
        "Shellbell is still open because shutdown could not be verified. Retry Quit, or reconnect in Advanced."
    }
    if serviceError == .startupUnavailable {
      return
        "This app build cannot enable automatic startup. You can still open Shellbell manually. Install a properly signed build to start at login."
    }
    if serviceError == .operationFailed {
      return
        "The service change did not finish. Check the service status and recovery controls before trying again."
    }
    return phase.notice
  }
  public var settingsApplied: String { settings["applied"].string ?? "unknown" }
  public var canMutate: Bool {
    phase == .idle && status != .null && connection.isReady && quitCompletion == nil
  }
  public var busy: Bool { if case .busy = phase { true } else { false } }
  public var serviceAvailable: Bool {
    canMutate && status["local"]["kind"] == .string("verified") && runtime != .null
  }

  /// Power readiness is not UI mutation availability. A metadata request may
  /// disable buttons while the last verified desktop process remains healthy.
  public func powerEligibility(power: ExternalPower, isLaptop: Bool) -> PowerEligibility {
    let usablePhase: Bool
    switch phase {
    case .unavailable, .unknownDelivery, .recovery: usablePhase = false
    default: usablePhase = true
    }
    let age = lastRefresh.map { now().timeIntervalSince($0) }
    let fresh = age.map { $0.isFinite && $0 >= 0 && $0 <= 10 } ?? false
    let verified =
      usablePhase && connection.isReady && quitCompletion == nil
      && status["ownership"]["mode"] == .string("desktop")
      && status["ownership"]["consented"] == .bool(true)
      && status["selection"]["mode"] == .string("desktop")
      && status["ownership"]["transition"] == .null && status["transition"] == .null
      && status["local"]["kind"] == .string("verified") && runtime != .null
      && status["desktop"]["loaded"] == .bool(true)
      && (runtime["pid"].number ?? 0) > 0
      && status["desktop"]["pid"] == runtime["pid"]
    return .init(
      power: power, desktopServiceVerified: verified, statusFresh: fresh, isLaptop: isLaptop)
  }

  public var canRestartService: Bool {
    serviceAvailable && status["ownership"]["mode"] != .string("headless")
  }
  public var pairingOwned: Bool { ownedFlow != nil }
  public var expected: JSONValue { .object(["revision": status["revision"], "runtime": runtime]) }
  public var runtime: JSONValue { status["local"]["status"]["process"] }
  private let connection: any ControllerConnection
  private let now: () -> Date
  private var ownedFlow: String?
  private var pairingRuntime: JSONValue = .null
  private var closeRequested = false
  private var refreshDevicesRequested = false
  private var pendingReads: Set<String> = []
  private var conflictNeeds: Set<String> = []
  private var quitCompletion: ((Bool) -> Void)?
  private var launchRequested = false
  private var launchHandled = false
  private var desktopMutationSent = false
  private var quitObserved = false
  private var backgroundReading = false
  private var pendingMutation: (() -> Void)?
  private var restartRequested = false
  public func launchDesktopIfConsented() {
    guard !launchHandled else { return }
    launchRequested = true
    drainFollowup()
  }
  public func disconnectForReconnect() {
    launchHandled = true
    launchRequested = false
    pendingMutation = nil
    restartRequested = false
    connection.close()
  }

  public init(connection: any ControllerConnection, now: @escaping () -> Date = Date.init) {
    self.connection = connection
    self.now = now
    connection.onEvent = { [weak self] in self?.event($0) }
    connection.onClosed = { [weak self] in
      guard let self else { return }
      self.clearPairing()
      if self.quitCompletion != nil { self.abortQuit(.unavailable) }
      if self.phase != .unknownDelivery { self.phase = .unavailable }
    }
  }
  public func connect() {
    guard !busy, !backgroundReading, quitCompletion == nil else { return }
    phase = .busy("hello")
    connection.connect { [weak self] result in
      guard let self else { return }
      self.phase = .idle
      if self.quitCompletion != nil {
        self.finishQuit()
        return
      }
      switch result {
      case .success: self.refresh()
      case .failure(let error): self.fail(error)
      }
    }
  }
  public func refresh() { enqueueReads(["status"]) }
  public func refreshInBackground() {
    guard phase == .idle, !backgroundReading, quitCompletion == nil, connection.isReady else {
      return
    }
    backgroundReading = true
    connection.request("status", args: nil) { [weak self] result in
      guard let self else { return }
      self.backgroundReading = false
      let queued = self.pendingMutation
      self.pendingMutation = nil
      switch result {
      case .success(let value):
        if value != self.status {
          self.acceptStatus(value)
        } else {
          self.lastRefresh = self.now()
          self.phase = self.observedPhase
        }
        if self.quitCompletion != nil {
          self.finishQuit()
        } else if let queued {
          queued()
        } else {
          self.drainFollowup()
        }
      case .failure(let error):
        self.fail(error)
        if self.quitCompletion != nil { self.abortQuit(error) }
      }
    }
  }
  public func loadSettings() { enqueueReads(["settings.get"]) }
  public func refreshSettings() { activateWindow("Settings") }
  public func loadDevices() { enqueueReads(["devices"]) }
  public func loadDiagnostics() { enqueueReads(["diagnostics"]) }
  /// Used by explicit showing and native focus callbacks. Only reads coalesce;
  /// the fixed set bounds deferred work and never replays mutations.
  public func activateWindow(_ name: String) {
    if name == "Advanced" {
      enqueueReads(["status", "settings.get", "diagnostics"])
      return
    }
    let payload = ["Settings": "settings.get", "Devices": "devices", "Diagnostics": "diagnostics"][
      name]
    enqueueReads(payload.map { ["status", $0] } ?? ["status"])
  }
  private func enqueueReads(_ commands: [String]) {
    guard quitCompletion == nil else { return }
    pendingReads.formUnion(commands.filter { phase != .busy($0) })
    drainFollowup()
  }
  private func mutation(
    _ command: String, extra: [String: JSONValue] = [:], recovery: Bool = false,
    success: ((JSONValue) -> Void)? = nil
  ) {
    if backgroundReading {
      guard pendingMutation == nil, canMutate else { return }
      let basis = expected
      let ownerRevision = status["ownership"]["revision"]
      pendingMutation = { [weak self] in
        guard let self else { return }
        guard self.expected == basis, self.status["ownership"]["revision"] == ownerRevision else {
          self.fail(.conflict)
          return
        }
        self.mutation(command, extra: extra, recovery: recovery, success: success)
      }
      phase = .busy(command)
      return
    }
    guard
      canMutate
        || (recovery && !busy && status != .null && connection.isReady && quitCompletion == nil)
    else { return }
    var args = extra
    args["expect"] = expected
    if command.hasPrefix("desktop.") || command.hasPrefix("ownership.") {
      args["ownerRevision"] = status["ownership"]["revision"]
    }
    send(command, args: .object(args), success: success ?? { self.acceptStatus($0) })
  }
  public func start(mode: String, migrateLegacy: Bool = false, stateDir: String? = nil) {
    var args: [String: JSONValue] = [
      "mode": .string(mode), "migrateLegacy": .bool(migrateLegacy), "consent": .bool(true),
    ]
    if let stateDir { args["stateDir"] = .string(stateDir) }
    mutation("service.start", extra: args)
  }
  public func stop() { mutation("service.stop") }
  public func setupDesktop() { mutation("desktop.setup", extra: ["consent": .bool(true)]) }
  public func startDesktop() { mutation("desktop.start") }
  public func stopDesktop() { mutation("desktop.stop", recovery: true) }
  public func setLoginStartup(_ enabled: Bool) {
    mutation("desktop.login.set", extra: ["enabled": .bool(enabled)])
  }
  public func convertOwnership(to target: String = "desktop") {
    mutation(
      "ownership.convert", extra: ["target": .string(target), "consent": .bool(true)],
      recovery: true)
  }
  public func recoverOwnership() {
    guard status["ownership"]["transition"]["id"] != .null else { return }
    mutation(
      "ownership.recover", extra: ["intentId": status["ownership"]["transition"]["id"]],
      recovery: true)
  }
  public func restart() {
    guard canRestartService else { return }
    if status["ownership"]["mode"] == .string("desktop") {
      mutation("desktop.stop") { value in
        self.acceptStatus(value)
        self.restartRequested = true
      }
    } else {
      mutation("service.restart")
    }
  }
  public func remove() { mutation("service.remove", recovery: true) }
  public func recover(action: String, restartPrevious: Bool = false) {
    mutation(
      "service.recover",
      extra: [
        "action": .string(action), "restartPrevious": .bool(restartPrevious),
        "consent": .bool(true),
      ], recovery: true)
  }
  public func saveSettings(
    changes: [String: String], revision: JSONValue, saved: @escaping (JSONValue) -> Void = { _ in }
  ) {
    guard revision != .null else { return }
    let batch = changes.sorted { $0.key < $1.key }.map {
      JSONValue.object(["key": .string($0.key), "value": .string($0.value)])
    }
    mutation(
      "settings.set",
      extra: ["configRevision": revision, "changes": .array(batch)]
    ) {
      self.settings = $0
      saved($0)
    }
  }
  public func revoke(_ fingerprint: String) {
    guard serviceAvailable else { return }
    mutation("devices.revoke", extra: ["phoneFp": .string(fingerprint)]) { _ in
      self.refreshDevicesRequested = true
    }
  }
  public func openPairing() {
    guard serviceAvailable, ownedFlow == nil else { return }
    let owner = runtime
    mutation("pairing.open") { value in
      self.pairing = value
      self.ownedFlow = value["flowId"].string
      self.pairingRuntime = owner
      self.consent = .null
    }
  }
  public func closePairing() {
    guard ownedFlow != nil || phase == .busy("pairing.open") else { return }
    closeRequested = true
    pairing = .null
    consent = .null
    drainFollowup()
  }
  public func confirmPairing(accept: Bool, challengeId: String) {
    guard serviceAvailable, pairingRuntime == runtime, let ownedFlow, consent != .null,
      consent["flowId"] == .string(ownedFlow),
      consent["challengeId"] == .string(challengeId), !expired
    else { return }
    let challenge = consent
    mutation(
      "pairing.confirm",
      extra: [
        "flowId": .string(ownedFlow), "challengeId": challenge["challengeId"],
        "phoneFp": challenge["phoneFp"], "accept": .bool(accept),
      ]
    ) { _ in
      if self.consent["challengeId"] == challenge["challengeId"] { self.consent = .null }
      self.refreshDevicesRequested = true
    }
  }
  private var expired: Bool {
    (pairing["expiresAt"].number ?? 0) <= now().timeIntervalSince1970 * 1000
  }
  public func tick() { if pairing != .null && expired { closePairing() } }
  public func quit(_ completion: @escaping (Bool) -> Void) {
    guard quitCompletion == nil else { return }
    quitCompletion = completion
    quitFailed = false
    quitObserved = false
    pendingReads.removeAll()
    if !busy { finishQuit() }
  }
  private func finishQuit() {
    guard quitCompletion != nil, !busy, !backgroundReading else { return }
    let needsDesktopCheck = status["ownership"]["mode"] == .string("desktop") || desktopMutationSent
    if !needsDesktopCheck {
      completeQuit()
      return
    }
    guard connection.isReady else {
      abortQuit(.unavailable)
      return
    }
    if let ownedFlow {
      quitRequest(
        "pairing.close", args: .object(["expect": expected, "flowId": .string(ownedFlow)])
      ) { _ in
        self.clearPairing()
        self.finishQuit()
      }
      return
    }
    if !quitObserved {
      quitRequest("status") { value in
        self.acceptStatus(value)
        self.quitObserved = true
        self.finishQuit()
      }
      return
    }
    guard status["selection"]["mode"] == .string("desktop") else {
      completeQuit()
      return
    }
    quitRequest(
      "desktop.stop",
      args: .object([
        "expect": expected, "ownerRevision": status["ownership"]["revision"],
      ])
    ) { value in
      self.acceptStatus(value)
      guard value["local"]["kind"] == .string("absent"),
        value["desktop"]["loaded"] == .bool(false)
      else {
        self.abortQuit(.operationFailed)
        return
      }
      self.completeQuit()
    }
  }
  private func quitRequest(
    _ command: String, args: JSONValue? = nil, success: @escaping (JSONValue) -> Void
  ) {
    phase = .busy(command)
    connection.request(command, args: args) { [weak self] result in
      guard let self, self.quitCompletion != nil else { return }
      self.phase = .idle
      switch result {
      case .success(let value): success(value)
      case .failure(let error): self.abortQuit(error)
      }
    }
  }
  private func abortQuit(_ error: BridgeFailure) {
    let completion = quitCompletion
    quitCompletion = nil
    quitFailed = true
    fail(error)
    completion?(false)
  }
  private func completeQuit() {
    let completion = quitCompletion
    quitCompletion = nil
    clearPairing()
    connection.close()
    completion?(true)
  }
  private func clearPairing() {
    ownedFlow = nil
    pairing = .null
    consent = .null
    pairingRuntime = .null
    closeRequested = false
    refreshDevicesRequested = false
  }
  private func acceptStatus(_ value: JSONValue) {
    let previous = runtime
    status = value
    lastRefresh = now()
    if previous != runtime && ownedFlow != nil {
      clearPairing()
      connection.close()
      phase = .unavailable
      return
    }
    phase = observedPhase
  }
  private var observedPhase: ControllerPhase {
    if !conflictNeeds.isEmpty { return .conflict }
    if status["transition"]["phase"] == .string("awaiting-approval")
      || status["persistent"]["registration"] == .string("requires-approval")
    {
      return .approval
    }
    return status["transition"] != .null || status["ownership"]["transition"] != .null
      ? .recovery : .idle
  }
  private func fail(_ error: BridgeFailure) {
    self.error = error
    switch error {
    case .deliveryUnknown:
      phase = .unknownDelivery
      clearPairing()
    case .approvalRequired: phase = .approval
    case .conflict: phase = .conflict
    case .recoveryRequired, .unsafeState: phase = .recovery
    case .startupUnavailable: phase = observedPhase
    default: phase = .unavailable
    }
  }
  private func send(
    _ command: String, args: JSONValue? = nil, success: @escaping (JSONValue) -> Void
  ) {
    guard !busy, !backgroundReading, quitCompletion == nil, connection.isReady else { return }
    phase = .busy(command)
    let lifecycle =
      command.hasPrefix("service.") || command.hasPrefix("desktop.")
      || command.hasPrefix("ownership.")
    if lifecycle { serviceError = nil }
    if command.hasPrefix("desktop.") || command.hasPrefix("ownership.") {
      desktopMutationSent = true
    }
    if conflictNeeds.isEmpty { error = nil }
    connection.request(command, args: args) { [weak self] result in
      guard let self else { return }
      let releaseRequested = self.closeRequested
      switch result {
      case .success(let data):
        self.conflictNeeds.remove(command)
        self.phase = self.observedPhase
        if self.conflictNeeds.isEmpty { self.error = nil }
        success(data)
      case .failure(let error):
        if command == "pairing.confirm", !releaseRequested {
          if error == .operationFailed, let answered = args?["challengeId"],
            self.consent["challengeId"] == answered
          {
            self.consent = .null
          }
          self.pendingReads.insert("status")
        }
        if lifecycle {
          self.serviceError = error
          if error == .operationFailed || error == .recoveryRequired {
            self.pendingReads.insert("status")
          }
        }
        if error == .conflict {
          self.conflictNeeds = command == "settings.set" ? ["status", "settings.get"] : ["status"]
        }
        self.fail(error)
        // Closing the owner connection releases any server-side flow even when an
        // expected revision is stale or the failed result leaves delivery unknown.
        // Never retry the mutation that just failed, including pairing.close itself.
        if releaseRequested { self.disconnectPairingOwner() }
      }
      if self.quitCompletion != nil { self.finishQuit() } else { self.drainFollowup() }
    }
  }
  private func drainFollowup() {
    guard !busy, !backgroundReading, quitCompletion == nil else { return }
    if closeRequested {
      guard let ownedFlow, canMutate else {
        disconnectPairingOwner()
        return
      }
      // Keep the intent until the admitted close settles. An error disconnects
      // the owning client; a success clears the intent together with ownership.
      mutation("pairing.close", extra: ["flowId": .string(ownedFlow)]) { _ in
        let refresh = self.refreshDevicesRequested
        self.clearPairing()
        self.refreshDevicesRequested = refresh
      }
      return
    } else if refreshDevicesRequested {
      refreshDevicesRequested = false
      pendingReads.insert("devices")
    }
    guard connection.isReady else { return }
    if restartRequested {
      restartRequested = false
      startDesktop()
      return
    }
    for command in ["status", "settings.get", "devices", "diagnostics"]
    where pendingReads.contains(command) {
      pendingReads.remove(command)
      send(command) { value in
        switch command {
        case "status": self.acceptStatus(value)
        case "settings.get": self.settings = value
        case "devices": self.devices = value.array ?? []
        default: self.diagnostics = value["checks"].array ?? []
        }
      }
      return
    }
    if launchRequested && !launchHandled && status != .null {
      launchHandled = true
      launchRequested = false
      if status["ownership"]["mode"] == .string("desktop"),
        status["ownership"]["consented"] == .bool(true),
        status["ownership"]["transition"] == .null, status["transition"] == .null,
        status["local"]["kind"] == .string("absent")
      {
        startDesktop()
      }
    }
  }
  private func disconnectPairingOwner() {
    clearPairing()
    connection.close()
  }
  private func event(_ value: JSONValue) {
    guard let ownedFlow, value["flowId"] == .string(ownedFlow), pairingRuntime == runtime else {
      return
    }
    if value["event"] == .string("pairing.closed") {
      clearPairing()
      refreshDevicesRequested = true
      drainFollowup()
    } else if !expired, value["challengeId"] != consent["challengeId"] {
      consent = value
    }
  }
}
