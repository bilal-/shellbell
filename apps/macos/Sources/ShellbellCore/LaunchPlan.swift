import Darwin
import Foundation

public enum EntryMode: Equatable, Sendable {
  case ui, help, version
  case serviceAPI(String)
  case loginAPI(String)
  case serviceRun(String)
  public static func parse(_ arguments: [String]) throws -> EntryMode {
    switch arguments {
    case []: return .ui
    case ["--help"]: return .help
    case ["--version"]: return .version
    default:
      if arguments.count == 2, arguments[0] == "--login-api",
        ["status", "register", "unregister"].contains(arguments[1]) {
        return .loginAPI(arguments[1])
      }
      if arguments.count == 2, arguments[0] == "--service-api",
        ["status", "register", "unregister"].contains(arguments[1])
      {
        return .serviceAPI(arguments[1])
      }
      if arguments.count == 2, arguments[0] == "--service-run",
        ["manual", "persistent", "desktop"].contains(arguments[1])
      {
        return .serviceRun(arguments[1])
      }
      throw BridgeFailure.badRequest
    }
  }
}

public struct LaunchPlan: Sendable {
  public let executable: String
  public let arguments: [String]
  public let environment: [String: String]
  public let home: String
  public init(bundle: String, home: String, user: String, serviceMode: String? = nil) throws {
    guard Wire.path(.string(bundle)), Wire.path(.string(home)), !user.isEmpty,
      URL(fileURLWithPath: bundle).lastPathComponent == "Shellbell.app",
      Self.canonicalComponents(bundle),
      serviceMode == nil || ["manual", "persistent", "desktop"].contains(serviceMode!)
    else { throw BridgeFailure.unsafeState }
    self.home = home
    let resources = bundle + "/Contents/Resources"
    executable = bundle + "/Contents/Helpers/node"
    arguments =
      serviceMode.map { [resources + "/agent/dist/native-service.js", $0] }
      ?? [resources + "/agent/dist/native-controller.js"]
    environment = [
      "HOME": home, "USER": user, "LOGNAME": user, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
      "LANG": "en_US.UTF-8",
    ]
  }
  public static func account() throws -> (home: String, user: String) {
    guard getuid() > 0, let record = getpwuid(getuid()), let dir = record.pointee.pw_dir,
      let name = record.pointee.pw_name
    else { throw BridgeFailure.unsafeState }
    return (String(cString: dir), String(cString: name))
  }
  public func validateFiles() throws {
    for path in [executable, arguments[0]] {
      try Self.validateFile(path)
    }
    guard access(executable, X_OK) == 0 else { throw BridgeFailure.unsafeState }
  }
  public static func validateFile(_ path: String) throws {
    guard Wire.path(.string(path)), canonicalComponents(path)
    else { throw BridgeFailure.unsafeState }
    var current = URL(fileURLWithPath: path)
    var leaf = true
    while current.path != "/" {
      var info = stat()
      guard lstat(current.path, &info) == 0, (info.st_mode & S_IFMT) == (leaf ? S_IFREG : S_IFDIR),
        info.st_uid == 0 || info.st_uid == getuid(), info.st_mode & 0o022 == 0
      else { throw BridgeFailure.unsafeState }
      leaf = false
      current.deleteLastPathComponent()
    }
  }
  private static func canonicalComponents(_ path: String) -> Bool {
    path == "/"
      || (path.hasPrefix("/")
        && path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy {
          !$0.isEmpty && $0 != "." && $0 != ".."
        })
  }
}
