import Foundation
import ServiceManagement
import ShellbellCore

@MainActor enum ServiceAPI {
  static let plistName = "sh.bilal.shellbell.host.agent.plist"
  static func admittedBundle() throws -> String {
    let bundle = Bundle.main
    guard bundle.bundleIdentifier == "sh.bilal.shellbell.host",
      bundle.object(forInfoDictionaryKey: "CFBundleExecutable") as? String == "Shellbell",
      bundle.bundleURL.lastPathComponent == "Shellbell.app"
    else { throw BridgeFailure.unsafeState }
    for relative in [
      "Contents/MacOS/Shellbell", "Contents/Info.plist",
      "Contents/Library/LaunchAgents/" + plistName,
    ] {
      try LaunchPlan.validateFile(bundle.bundleURL.appendingPathComponent(relative).path)
    }
    return bundle.bundleURL.path
  }
  static func run(_ verb: String) -> Int32 {
    var service: SMAppService?
    let result = ServiceHelper.perform(
      verb,
      admit: {
        _ = try admittedBundle()
        service = SMAppService.agent(plistName: plistName)
      },
      status: {
        switch service?.status {
        case .notRegistered: "not-registered"
        case .enabled: "enabled"
        case .requiresApproval: "requires-approval"
        case .notFound: "not-found"
        default: "unknown"
        }
      }, register: { try service?.register() }, unregister: { try service?.unregister() })
    guard let data = try? JSONEncoder().encode(result) else { return 1 }
    FileHandle.standardOutput.write(data + Data([10]))
    return result["ok"] == .bool(true) ? 0 : 1
  }
}
