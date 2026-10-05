import Foundation
import ServiceManagement
import ShellbellCore

/// The main application's login item is separate from the legacy agent job.
@MainActor enum LoginStartupAPI {
  static func run(_ verb: String) -> Int32 {
    var service: SMAppService?
    let result = ServiceHelper.perform(
      verb,
      admit: {
        _ = try ServiceAPI.admittedBundle()
        service = SMAppService.mainApp
      },
      status: {
        switch service?.status {
        case .notRegistered: "not-registered"
        case .enabled: "enabled"
        case .requiresApproval: "requires-approval"
        case .notFound: "not-found"
        default: "unknown"
        }
      },
      register: { try service?.register() },
      unregister: { try service?.unregister() })
    guard let data = try? JSONEncoder().encode(result) else { return 1 }
    FileHandle.standardOutput.write(data + Data([10]))
    return result["ok"] == .bool(true) ? 0 : 1
  }
}
