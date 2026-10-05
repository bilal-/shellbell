import Combine
import ShellbellCore

/// Explicit Settings actions; ordinary refresh never creates or cancels a hold.
@MainActor public final class PowerMaintenanceActions: ObservableObject {
  @Published public private(set) var registrationStatus: PowerRegistrationStatus
  @Published public private(set) var busy = false
  @Published public private(set) var error: String?
  private let registration: PowerHelperRegistration
  private let disableClosedLid: () -> Bool
  private let preparePower: (@escaping (Bool) -> Void) -> Void
  private let finishPower: () -> Void
  private let makeClient: () throws -> PowerClient

  public init(
    registration: PowerHelperRegistration,
    disableClosedLid: @escaping () -> Bool,
    preparePower: @escaping (@escaping (Bool) -> Void) -> Void,
    finishPower: @escaping () -> Void,
    makeClient: @escaping () throws -> PowerClient
  ) {
    self.registration = registration
    self.registrationStatus = registration.status
    self.disableClosedLid = disableClosedLid
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

  public func offersRecovery(powerStatus: PowerStatus) -> Bool {
    powerStatus == .maintenance || error != nil
  }

  public func remove() async {
    refresh()
    guard canRemoveHelper else { return }
    await perform(removing: true)
  }
  public func cancelRemoval() async { await perform(removing: false) }

  private func perform(removing: Bool) async {
    guard !busy else { return }
    busy = true
    error = nil
    defer {
      refresh()
      busy = false
    }
    guard disableClosedLid() else {
      error = "Could not save the safe sleep preference. No helper changes were made."
      return
    }
    // Persist safe intent before stopping renewal; a later launch must not
    // automatically reacquire closed-lid protection during maintenance.
    let restored = await withCheckedContinuation { continuation in
      preparePower { continuation.resume(returning: $0) }
    }
    defer { finishPower() }
    guard restored else {
      error = "Normal sleep could not be verified. Retry power recovery before changing the helper."
      return
    }
    do {
      let client = try makeClient()
      if removing {
        try await registration.remove(client: client)
      } else {
        try await registration.cancelRemoval(client: client)
      }
    } catch PowerHelperRegistration.Failure.sleepConflict {
      self.error =
        "Another sleep controller is blocking helper maintenance. Quit other sleep-management apps or undo a system sleep override, then retry. The helper was not removed; any maintenance hold remains in place."
    } catch {
      self.error =
        removing
        ? "Helper removal was not verified. Closed-lid access remains off. Retry removal or explicitly cancel maintenance."
        : "Maintenance recovery was not verified. Keep closed-lid access off and retry after any update or removal has finished."
    }
  }
}
