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
  /// The running service's account of each terminal; nil until read or when it cannot say.
  @Published public private(set) var terminals: [TerminalSetup]?
  /// The running service is too old to report terminals.
  @Published public private(set) var terminalsUnsupported = false
  /// The coding agents found on this computer; nil until read, or when they can't be read.
  @Published public private(set) var agents: [AgentSetup]?
  @Published public private(set) var agentsFailure: String?
  /// Why the last setup, skip or removal failed. Reads don't clear it, so the reason stays in
  /// view while the list reloads; the next change that works does.
  @Published public private(set) var agentsChangeFailure: String?
  @Published public private(set) var diagnostics: [JSONValue] = []
  @Published public private(set) var pairing: JSONValue = .null
  @Published public private(set) var consent: JSONValue = .null
  @Published public private(set) var lastRefresh: Date?
  @Published public private(set) var error: BridgeFailure?
  @Published public private(set) var serviceError: BridgeFailure?
  @Published public private(set) var quitFailed = false
  /// The controller connection ended without Reconnect or Quit asking for it. Remote access ended
  /// with it: the desktop service lives exactly as long as this connection.
  @Published public private(set) var connectionLost = false
  /// Told once when the connection is lost, with whether remote access was running at the time.
  public var onConnectionLost: ((_ remoteAccessWasRunning: Bool) -> Void)?
  private var closingOnPurpose = false
  private var quitCheckRequired = false
  /// For a connection replacing a lost one: Quit first confirms remote access ended with it.
  public func requireQuitCheck() { quitCheckRequired = true }
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
    if serviceKeepsStopping {
      return
        "Remote access stopped unexpectedly several times, so Shellbell left it off. Start it again at the top of General."
    }
    if connectionLost && phase == .unavailable {
      return
        "Remote access stopped unexpectedly. Shellbell is starting it again; you can also reconnect in Advanced."
    }
    if phase == .idle, settingsRejected, error == .invalidConfig {
      return "Shellbell didn’t save these settings. Check that each value is allowed and save again. If it keeps failing, the saved settings file may be damaged; run shellbell doctor in Terminal."
    }
    return phase.notice
  }
  public var settingsApplied: String { settings["applied"].string ?? "unknown" }
  public var canMutate: Bool {
    phase == .idle && status != .null && connection.isReady && quitCompletion == nil
  }
  public var busy: Bool { if case .busy = phase { true } else { false } }
  /// The desktop service was last seen running under this connection, or was being started.
  var remoteAccessRunning: Bool {
    (launchRequested && !launchHandled) || desktopStartUnsettled || Self.serving(status)
  }
  /// The desktop service is running and answering.
  static func serving(_ status: JSONValue) -> Bool {
    status["ownership"]["mode"] == .string("desktop")
      && status["selection"]["mode"] == .string("desktop")
      && status["local"]["kind"] == .string("verified")
  }
  /// The desktop service stopped without being asked: start it again, unless it keeps stopping.
  private func serviceStopped() {
    let window = now().addingTimeInterval(-600)
    unexpectedStops.removeAll { $0 < window }
    guard unexpectedStops.count < 3 else {
      serviceKeepsStopping = true
      return
    }
    unexpectedStops.append(now())
    restartRequested = true
  }
  private var unexpectedStops: [Date] = []
  /// The last service change this app sent was a stop or a change of mode, not a start.
  private var stoppedOnPurpose = false
  /// Remote access stopped by itself three times in ten minutes, so it was left off.
  @Published public private(set) var serviceKeepsStopping = false
  /// Starting desktop remote access was interrupted: the recorded change is desktop to desktop.
  var interruptedDesktopStart: Bool {
    let owner = status["ownership"]["transition"]
    return owner["source"] == .string("desktop") && owner["target"] == .string("desktop")
      && (status["transition"] == .null || status["transition"]["action"] == .string("start"))
  }
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
  /// `afterLoss` restarts remote access lost with an earlier connection. That service stops by
  /// itself once its connection is gone, so wait for it rather than mistake it for a running one.
  public func launchDesktopIfConsented(afterLoss: Bool = false) {
    guard !launchHandled else { return }
    launchRequested = true
    stopWaits = afterLoss ? 0 : nil
    drainFollowup()
  }
  private let after: (TimeInterval, @escaping @MainActor () -> Void) -> Void
  /// Status reads made while waiting for a lost connection's service to stop; nil when not waiting.
  private var stopWaits: Int?
  private var stopWaitScheduled = false
  /// A desktop.start was sent and hasn't been answered either way. The connection's failure
  /// reaches the request before the loss is reported, so `phase` can't be used for this.
  private var desktopStartUnsettled = false
  public func disconnectForReconnect() {
    launchHandled = true
    launchRequested = false
    pendingMutation = nil
    restartRequested = false
    closingOnPurpose = true
    connection.close()
  }

  public init(
    connection: any ControllerConnection, now: @escaping () -> Date = Date.init,
    after: @escaping (TimeInterval, @escaping @MainActor () -> Void) -> Void = { delay, action in
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated(action) }
    }
  ) {
    self.connection = connection
    self.now = now
    self.after = after
    connection.onEvent = { [weak self] in self?.event($0) }
    connection.onClosed = { [weak self] in
      guard let self else { return }
      let lost = !self.closingOnPurpose && self.quitCompletion == nil
      let wasRunning = self.remoteAccessRunning
      self.clearPairing()
      if self.quitCompletion != nil { self.abortQuit(.unavailable) }
      if self.phase != .unknownDelivery { self.phase = .unavailable }
      if lost {
        self.connectionLost = true
        self.onConnectionLost?(wasRunning)
      }
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
  /// UI conflicts and approval can coexist with a verified running service; background reads
  /// keep its evidence fresh without relaxing mutation or conflict gates, one at a time.
  private var mayReadInBackground: Bool {
    (phase == .idle || phase == .conflict || phase == .approval) && !backgroundReading
      && quitCompletion == nil && connection.isReady
  }
  /// After a background read: an action queued behind it marked the app busy, so the app returns
  /// to its observed state first; then Quit finishes, or the queued action or deferred reads run.
  private func continueAfterBackgroundRead(_ queued: (() -> Void)?) {
    if busy { phase = observedPhase }
    if quitCompletion != nil {
      finishQuit()
    } else if let queued {
      queued()
    } else {
      drainFollowup()
    }
  }
  /// Reads status unless one arrived within `age` seconds. Each read costs the controller several
  /// process launches, so a periodic check skips when another reader, such as keep-awake's own
  /// refresh, has just read it.
  public func refreshInBackground(ifOlderThan age: TimeInterval) {
    if let last = lastRefresh, now().timeIntervalSince(last) < age { return }
    refreshInBackground()
  }

  public func refreshInBackground() {
    guard mayReadInBackground else { return }
    backgroundReading = true
    connection.request("status", args: nil) { [weak self] result in
      guard let self else { return }
      self.backgroundReading = false
      let releaseRequested = self.closeRequested
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
        self.continueAfterBackgroundRead(queued)
      case .failure(let error):
        self.failRead(error)
        if releaseRequested { self.disconnectPairingOwner() }
        if self.quitCompletion != nil { self.abortQuit(error) }
      }
    }
  }
  public func loadSettings() { enqueueReads(["settings.get"]) }
  public func refreshSettings() { activateWindow("Settings") }
  public func loadDevices() { enqueueReads(["devices"]) }
  /// Reads each terminal's setup without disturbing other controls: a stopped service only
  /// clears the list, it never marks the whole app unavailable.
  public func loadTerminals() { terminalRequest("terminals", args: nil) }
  /// Connect iTerm2: lets the service make macOS and iTerm2 ask. Returns before they answer.
  /// A click while a read is out waits for it, like any other action, instead of being lost.
  public func connectTerminal(_ name: String) {
    if backgroundReading {
      guard pendingMutation == nil, canMutate else { return }
      pendingMutation = { [weak self] in self?.connectTerminal(name) }
      // Like any queued action, other actions wait instead of being dropped.
      phase = .busy("terminals.connect")
      return
    }
    terminalRequest("terminals.connect", args: .object(["name": .string(name)]))
  }
  private func terminalRequest(_ command: String, args: JSONValue?) {
    guard mayReadInBackground, status["local"]["kind"] == .string("verified") else {
      if status != .null, status["local"]["kind"] != .string("verified") { terminals = nil }
      return
    }
    backgroundReading = true
    connection.request(command, args: args) { [weak self] result in
      guard let self else { return }
      self.backgroundReading = false
      if case .success(let value) = result {
        self.terminalsUnsupported = value["supported"] == .bool(false)
        self.terminals = self.terminalsUnsupported ? nil : TerminalSetup.list(value)
      } else {
        self.terminals = nil
      }
      let queued = self.pendingMutation
      self.pendingMutation = nil
      self.continueAfterBackgroundRead(queued)
    }
  }
  public func loadAgents() { agentsRequest("agents", args: nil) }
  /// Adds the helpers that give the phone each agent's full history. The service needn't run:
  /// this only edits the agents' settings. `then` runs once the change has settled.
  public func setupAgents(_ kinds: [String], then: (() -> Void)? = nil) {
    agentsChange("agents.setup", args: .object(["kinds": .array(kinds.map(JSONValue.string))]), then)
  }
  public func skipAgents(_ kinds: [String], then: (() -> Void)? = nil) {
    agentsChange("agents.skip", args: .object(["kinds": .array(kinds.map(JSONValue.string))]), then)
  }
  public func removeAgent(_ kind: String) {
    agentsChange("agents.remove", args: .object(["kind": .string(kind)]), nil)
  }
  private func agentsChange(_ command: String, args: JSONValue, _ then: (() -> Void)?) {
    if backgroundReading {
      guard pendingMutation == nil, canMutate else { return }
      pendingMutation = { [weak self] in self?.agentsChange(command, args: args, then) }
      phase = .busy(command)
      return
    }
    agentsRequest(command, args: args, then: then)
  }
  private func agentsRequest(_ command: String, args: JSONValue?, then: (() -> Void)? = nil) {
    guard mayReadInBackground else { return }
    backgroundReading = true
    connection.request(command, args: args) { [weak self] result in
      guard let self else { return }
      self.backgroundReading = false
      var succeeded = false
      switch result {
      case .success(let value):
        self.agents = AgentSetup.list(value)
        self.agentsFailure = nil
        if args != nil { self.agentsChangeFailure = nil }
        succeeded = true
      case .failure:
        // Never show a stale list after a change that may not have happened.
        self.agents = nil
        if args == nil {
          self.agentsFailure = "Shellbell couldn't check your coding agents."
        } else {
          self.agentsChangeFailure =
            "Shellbell couldn't change your coding agents' settings. You can skip this and set them up later in Settings."
        }
      }
      let queued = self.pendingMutation
      self.pendingMutation = nil
      // A follow-up, such as starting the service after setup, runs like any queued action, and
      // only once the change has worked: after a failure the owner sees why and chooses again.
      self.continueAfterBackgroundRead(queued ?? (succeeded ? then : nil))
    }
  }
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
    let admitted = canMutate
      || (recovery && !busy && status != .null && connection.isReady && quitCompletion == nil)
    if backgroundReading {
      guard pendingMutation == nil, admitted else { return }
      let basis = expected
      let ownerRevision = status["ownership"]["revision"]
      pendingMutation = { [weak self] in
        guard let self else { return }
        guard self.expected == basis, self.status["ownership"]["revision"] == ownerRevision else {
          let releaseRequested = self.closeRequested
          self.fail(.conflict)
          if releaseRequested { self.disconnectPairingOwner() }
          return
        }
        self.mutation(command, extra: extra, recovery: recovery, success: success)
      }
      phase = .busy(command)
      return
    }
    guard admitted else { return }
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
    let needsDesktopCheck =
      status["ownership"]["mode"] == .string("desktop") || desktopMutationSent || quitCheckRequired
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
    closingOnPurpose = true
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
    let wasServing = Self.serving(status)
    status = value
    lastRefresh = now()
    if Self.serving(value) {
      serviceKeepsStopping = false
    } else if wasServing, !stoppedOnPurpose, quitCompletion == nil,
      value["ownership"]["mode"] == .string("desktop"), value["local"]["kind"] == .string("absent"),
      value["desktop"]["loaded"] != .bool(true), value["ownership"]["transition"] == .null,
      value["transition"] == .null
    {
      serviceStopped()
    }
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
  /// The last settings.set was refused for a value; the notice asks for a correction.
  private var settingsRejected = false
  /// A read that was slow, refused as busy or not understood leaves the connection and the
  /// service as they were. Keep the last status, which goes stale and is read again on the next
  /// tick, rather than treating the whole controller as unavailable.
  private func failRead(_ error: BridgeFailure) {
    guard connection.isReady, [.timeout, .busy, .badRequest].contains(error) else {
      fail(error)
      return
    }
    phase = observedPhase
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
    // Commands that end with the desktop service running, and those that stop it on purpose.
    let toDesktop = command == "ownership.convert" && args?["target"] == .string("desktop")
    let startsRemoteAccess =
      ["desktop.start", "desktop.setup"].contains(command) || toDesktop
      || (command == "ownership.recover"
        && status["ownership"]["transition"]["target"] == .string("desktop"))
    if startsRemoteAccess { desktopStartUnsettled = true }
    let intentBefore = stoppedOnPurpose
    if startsRemoteAccess {
      stoppedOnPurpose = false
    } else if ["desktop.stop", "ownership.convert", "service.stop", "service.remove"].contains(
      command)
    {
      stoppedOnPurpose = true
    }
    if command.hasPrefix("desktop.") || command.hasPrefix("ownership.") {
      desktopMutationSent = true
    }
    if conflictNeeds.isEmpty { error = nil }
    settingsRejected = false
    connection.request(command, args: args) { [weak self] result in
      guard let self else { return }
      let releaseRequested = self.closeRequested
      if startsRemoteAccess, result.failureValue != .deliveryUnknown {
        self.desktopStartUnsettled = false
      }
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
        if command == "settings.set", error == .invalidConfig {
          // A refused save leaves the running service as it was. The code also covers a saved file
          // that cannot be read; the notice names both. (From settings.get it can only mean the
          // file, which takes the usual unavailable path.)
          self.error = error
          self.settingsRejected = true
          self.phase = self.observedPhase
        } else if args == nil {
          self.failRead(error)
        } else if error == .busy, self.connection.isReady {
          // Something else holds the controller for a moment, such as `shellbell pair` in a
          // terminal. The connection is fine: show what is current and let the owner try again.
          self.error = error
          self.phase = self.observedPhase
          self.pendingReads.insert("status")
          // Refused before it ran, so the service is as it was; so is the reason it is running.
          self.stoppedOnPurpose = intentBefore
        } else {
          self.fail(error)
        }
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
      // A service shutting down still answers as running. About 15 seconds covers its own
      // 10-second stop limit; after that it is treated as running, as on any other launch.
      // The new controller did not start it, so it may also report it as someone else's.
      let kind = status["local"]["kind"].string
      let stillStopping =
        ["verified", "unverified"].contains(kind)
        || (kind == "foreign" && status["desktop"]["loaded"] != .bool(true))
      if let waits = stopWaits, waits < 30, status["ownership"]["mode"] == .string("desktop"),
        stillStopping
      {
        guard !stopWaitScheduled else { return }
        stopWaits = waits + 1
        stopWaitScheduled = true
        after(0.5) { [weak self] in
          self?.stopWaitScheduled = false
          self?.refresh()
        }
        return
      }
      launchHandled = true
      launchRequested = false
      stopWaits = nil
      guard status["ownership"]["mode"] == .string("desktop"),
        status["ownership"]["consented"] == .bool(true),
        status["local"]["kind"] == .string("absent")
      else { return }
      if status["ownership"]["transition"] == .null, status["transition"] == .null {
        startDesktop()
      } else if interruptedDesktopStart {
        // The app or its controller stopped part-way through starting remote access. Continuing
        // the recorded start is what Continue Setup does; a change of mode still waits for it.
        recoverOwnership()
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

extension Result where Failure == BridgeFailure {
  fileprivate var failureValue: BridgeFailure? {
    if case .failure(let error) = self { error } else { nil }
  }
}
