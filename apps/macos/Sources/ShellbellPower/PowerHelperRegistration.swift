import ServiceManagement
import ShellbellCore

public enum PowerRegistrationStatus: Sendable {
  case notRegistered, notFound, enabled, requiresApproval, unavailable
}

@MainActor public protocol PowerServiceRegistration {
  var status: PowerRegistrationStatus { get }
  func checkLegacyInstallation() throws -> Bool
  func register() throws
  func unregister() async throws
}

@MainActor public final class PowerHelperRegistration {
  public enum Failure: Error {
    case consentRequired, unavailable, restorationRequired, removalUnverified, legacyInstallation,
      sleepConflict
  }
  private let service: any PowerServiceRegistration

  public init(service: any PowerServiceRegistration = NativePowerServiceRegistration()) {
    self.service = service
  }

  public var status: PowerRegistrationStatus { service.status }

  private func checkExternalSleepConflict(_ reply: PowerReply) throws {
    if !reply.ok, reply.state == .conflict, reply.error == "conflict" {
      throw Failure.sleepConflict
    }
  }

    /// Explicit enable only. An idle helper needs no maintenance; a leftover
    /// hold is recovered with its authenticated token. Never take over a lease.
    public func finishSetup(client: PowerClient) async throws {
        defer { client.close() }
        let reply = try await withCheckedThrowingContinuation { continuation in
            client.request(.status) { continuation.resume(with: $0) }
        }
        try checkExternalSleepConflict(reply)
        guard reply.ok else { throw Failure.restorationRequired }
        switch reply.state {
        case .idle: return
        case .maintenance: try await cancelRemoval(client: client)
        case .active, .conflict: throw Failure.sleepConflict
        case .unavailable, .recoveryRequired: throw Failure.restorationRequired
        }
    }

    /// Explicit user cancellation only, never called by polling/startup. Adopt
  /// the durable hold on this authenticated connection, then release its token.
  public func cancelRemoval(client: PowerClient) async throws {
    defer { client.close() }
    let held = try await withCheckedThrowingContinuation { continuation in
      client.prepareRemoval { continuation.resume(with: $0) }
    }
    try checkExternalSleepConflict(held)
    guard held.ok, held.state == .maintenance, let token = held.leaseID else {
      throw Failure.restorationRequired
    }
    let released = try await withCheckedThrowingContinuation { continuation in
      client.request(.release, leaseID: token) { continuation.resume(with: $0) }
    }
    // The hold is cleared even if another sleep manager prevents a new lease.
    // Accept only verified absence of our hold, not active/unknown readback.
    try checkExternalSleepConflict(released)
    guard released.ok, released.state == .idle || released.state == .conflict,
      released.leaseID == nil
    else {
      throw Failure.restorationRequired
    }
  }

  /// Only called by an explicit setup action. Polling status never prompts.
  public func requestSetup(consented: Bool) throws -> PowerRegistrationStatus {
    guard consented else { throw Failure.consentRequired }
    guard try !service.checkLegacyInstallation() else { throw Failure.legacyInstallation }
    switch service.status {
    case .enabled, .requiresApproval: return service.status
    case .unavailable: throw Failure.unavailable
    case .notRegistered, .notFound: break
    }
    do {
      try service.register()
    } catch {
      // macOS can register the item but report that administrator approval is pending.
      guard service.status == .requiresApproval else { throw error }
    }
    let status = service.status
    guard status == .enabled || status == .requiresApproval else { throw Failure.unavailable }
    return status
  }

  /// The caller must release its active lease first. A fresh authenticated
  /// maintenance token proves restoration and blocks acquisition during removal.
  public func remove(client: PowerClient) async throws {
    // Keep the authenticated connection alive through OS unregistration. Closing
    // it deliberately does not clear the durable hold, even on failure.
    defer { client.close() }
    let reply = try await withCheckedThrowingContinuation { continuation in
      client.prepareRemoval { continuation.resume(with: $0) }
    }
    try checkExternalSleepConflict(reply)
    guard reply.ok, reply.state == .maintenance, reply.leaseID != nil else {
      throw Failure.restorationRequired
    }
    if service.status != .notRegistered { try await service.unregister() }
    guard service.status == .notRegistered else { throw Failure.removalUnverified }
  }
}

@MainActor public final class NativePowerServiceRegistration: PowerServiceRegistration {
  private let service = SMAppService.daemon(plistName: "sh.bilal.shellbell.power.plist")
  public init() {}
  public var status: PowerRegistrationStatus {
    switch service.status {
    case .notRegistered: return .notRegistered
    case .enabled: return .enabled
    case .requiresApproval: return .requiresApproval
    case .notFound: return .notFound
    @unknown default: return .unavailable
    }
  }
  public func checkLegacyInstallation() throws -> Bool {
    switch SMAppService.daemon(plistName: "dev.bilalahmad.shellbell.power.plist").status {
    case .enabled, .requiresApproval: return true
    case .notRegistered, .notFound: return try LegacyPowerAdmission.isPresent()
    @unknown default: throw PowerHelperRegistration.Failure.unavailable
    }
  }
  public func register() throws {
    guard try !checkLegacyInstallation() else {
      throw PowerHelperRegistration.Failure.legacyInstallation
    }
    // A never-registered service can report notFound even when its files exist.
    // Admit the signed app and bundled files before asking macOS to register it.
    _ = try PowerPeerVerifier.currentPublisher(role: .desktop)
    let bundle = Bundle.main
    guard bundle.bundleIdentifier == "sh.bilal.shellbell.host",
      bundle.bundleURL.lastPathComponent == "Shellbell.app"
    else { throw PowerHelperRegistration.Failure.unavailable }
    for relative in [
      "Contents/Info.plist",
      "Contents/Library/LaunchDaemons/sh.bilal.shellbell.power.plist",
      "Contents/Library/HelperTools/ShellbellPowerHelper",
    ] {
      try LaunchPlan.validateFile(bundle.bundleURL.appendingPathComponent(relative).path)
    }
    try service.register()
  }
  public func unregister() async throws {
    // Older SDKs import the async overload as nonisolated. Start the callback
    // variant on MainActor so the non-Sendable service never crosses executors.
    // The continuation alone may resume from ServiceManagement's callback queue.
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      service.unregister { error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume(returning: ())
        }
      }
    }
  }
}
