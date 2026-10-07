import Combine
import ShellbellCore

/// Power lifecycle actions are explicit; ordinary refresh never clears a hold.
@MainActor public final class PowerMaintenanceActions: ObservableObject {
  @Published public private(set) var registrationStatus: PowerRegistrationStatus
  @Published public private(set) var busy = false
  @Published public private(set) var error: String?
  private let registration: PowerHelperRegistration
  private let setClosedLidEnabled: (Bool) -> Void
  private let preparePower: (@escaping (Bool) -> Void) -> Void
  private let finishPower: () -> Void
  private let makeClient: () throws -> PowerClient
  private enum Operation { case enable, remove, cancelRemoval }

  public init(
    registration: PowerHelperRegistration,
    setClosedLidEnabled: @escaping (Bool) -> Void,
    preparePower: @escaping (@escaping (Bool) -> Void) -> Void,
    finishPower: @escaping () -> Void,
    makeClient: @escaping () throws -> PowerClient
  ) {
    self.registration = registration
    self.registrationStatus = registration.status
    self.setClosedLidEnabled = setClosedLidEnabled
    self.preparePower = preparePower
    self.finishPower = finishPower
    self.makeClient = makeClient
  }

  public func refresh() {
    let next = registration.status
    if registrationStatus != next { registrationStatus = next }
  }
  public var canRemoveHelper: Bool {
    registrationStatus == .enabled || registrationStatus == .requiresApproval
  }
  public func offersRecovery(powerStatus: PowerStatus, lidActive: Bool) -> Bool {
    powerStatus == .maintenance || error != nil || (registrationStatus == .enabled && !lidActive)
  }
  public func enableClosedLid() async -> PowerRegistrationStatus? { await perform(.enable) }
  public func remove() async {
    refresh()
    guard canRemoveHelper else { return }
    _ = await perform(.remove)
  }
  public func cancelRemoval() async { _ = await perform(.cancelRemoval) }

  private func perform(_ operation: Operation) async -> PowerRegistrationStatus? {
    guard !busy else { return nil }
    busy = true
    self.error = nil
    defer { refresh(); busy = false }
    // Stop this session's intent before restoring or changing the helper.
    setClosedLidEnabled(false)
    let restored = await withCheckedContinuation { continuation in
      preparePower { continuation.resume(returning: $0) }
    }
    defer { finishPower() }
    guard restored else {
      self.error = "Normal sleep could not be verified. Retry power recovery before changing the helper."
      return nil
    }
    do {
      switch operation {
      case .enable:
        let status = try registration.requestSetup(consented: true)
        if status == .enabled { try await registration.finishSetup(client: makeClient()) }
        setClosedLidEnabled(true)
        return status
      case .remove:
        try await registration.remove(client: makeClient())
      case .cancelRemoval:
        try await registration.cancelRemoval(client: makeClient())
      }
    } catch PowerHelperRegistration.Failure.sleepConflict {
      self.error = "Closed-lid access is in use or blocked by another sleep-management controller. Check the other controller and any system sleep override, then try again."
    } catch PowerHelperRegistration.Failure.legacyInstallation {
      self.error = "An older Shellbell power helper is installed. Remove it using the older app before setting up this version."
    } catch is PowerPeerVerifier.Failure {
      self.error = "Shellbell's publisher could not be verified. Install a signed Shellbell build and try again."
    } catch {
      switch operation {
      case .enable:
        self.error = "Closed-lid setup could not be verified. Check Shellbell in Login Items & Extensions, then try enabling it again."
      case .remove:
        self.error = "Helper removal was not verified. Closed-lid access remains off. Retry removal or finish setup."
      case .cancelRemoval:
        self.error = "Setup recovery was not verified. Retry after any update or removal has finished."
      }
    }
    return nil
  }
}
