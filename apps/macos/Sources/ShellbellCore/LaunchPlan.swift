import Darwin
import Foundation

public enum EntryMode: Equatable, Sendable {
  case ui, help, version
  case serviceAPI(String)
  case loginAPI(String)
  case serviceRun(String)
  /// Replaces the app after it quits: its pid, the checked copy, the installed app, the Trash
  /// destination and the failure record. Only a copy beside the installed app is accepted.
  case applyUpdate(pid: Int32, staged: String, target: String, trash: String, record: String)
  public static func parse(_ arguments: [String]) throws -> EntryMode {
    switch arguments {
    case []: return .ui
    case ["--help"]: return .help
    case ["--version"]: return .version
    default:
      if arguments.count == 6, arguments[0] == MacAppSwap.argument,
        let pid = Int32(arguments[1]), pid > 0,
        arguments[2...].allSatisfy({ $0.hasPrefix("/") && !$0.contains("\0") }),
        let staged = Optional(URL(fileURLWithPath: arguments[2])),
        let target = Optional(URL(fileURLWithPath: arguments[3])),
        staged.lastPathComponent.hasPrefix(".Shellbell-update-"), staged.pathExtension == "app",
        target.pathExtension == "app",
        staged.deletingLastPathComponent().path == target.deletingLastPathComponent().path,
        URL(fileURLWithPath: arguments[5]).lastPathComponent == MacAppSwap.failureRecord
      {
        return .applyUpdate(
          pid: pid, staged: arguments[2], target: arguments[3], trash: arguments[4],
          record: arguments[5])
      }
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
  /// `updateDownload` downloads that version's verified Mac installer into a private folder.
  public init(
    bundle: String, home: String, user: String, serviceMode: String? = nil,
    updateCheck: Bool = false, updateDownload: (version: String, folder: String)? = nil
  ) throws {
    guard Wire.path(.string(bundle)), Wire.path(.string(home)), !user.isEmpty,
      URL(fileURLWithPath: bundle).lastPathComponent == "Shellbell.app",
      Self.canonicalComponents(bundle),
      serviceMode == nil || ["manual", "persistent", "desktop"].contains(serviceMode!),
      [updateCheck, updateDownload != nil, serviceMode != nil].filter({ $0 }).count <= 1,
      updateDownload == nil || Self.validDownload(updateDownload!)
    else { throw BridgeFailure.unsafeState }
    self.home = home
    let resources = bundle + "/Contents/Resources"
    let cli = resources + "/agent/dist/cli.js"
    executable = bundle + "/Contents/Helpers/node"
    if let download = updateDownload {
      arguments = [cli, "update", download.version, "--download-mac", download.folder, "--json"]
    } else if updateCheck {
      arguments = [cli, "update", "--check", "--json"]
    } else {
      arguments =
        serviceMode.map { [resources + "/agent/dist/native-service.js", $0] }
        ?? [resources + "/agent/dist/native-controller.js"]
    }
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
        Self.trusted(uid: info.st_uid, gid: info.st_gid, mode: info.st_mode, leaf: leaf)
      else { throw BridgeFailure.unsafeState }
      leaf = false
      current.deleteLastPathComponent()
    }
  }
  /// Only this user or root may change a path the bridge runs. `/Applications` is the one standard
  /// exception: root-owned but writable by the admin group, whose members can already act as root,
  /// so trusting it gives nobody a way in they did not have. Files themselves stay strict.
  static func trusted(uid: uid_t, gid: gid_t, mode: mode_t, leaf: Bool) -> Bool {
    guard uid == 0 || uid == getuid(), mode & 0o002 == 0 else { return false }
    return mode & 0o020 == 0 || (!leaf && uid == 0 && gid == adminGroup)
  }
  private static let adminGroup: gid_t = 80
  private static func validDownload(_ download: (version: String, folder: String)) -> Bool {
    download.version.range(
      of: #"^(0|[1-9][0-9]{0,5})(\.(0|[1-9][0-9]{0,5})){2}$"#, options: .regularExpression) != nil
      && Wire.path(.string(download.folder)) && canonicalComponents(download.folder)
  }
  private static func canonicalComponents(_ path: String) -> Bool {
    path == "/"
      || (path.hasPrefix("/")
        && path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy {
          !$0.isEmpty && $0 != "." && $0 != ".."
        })
  }
}
