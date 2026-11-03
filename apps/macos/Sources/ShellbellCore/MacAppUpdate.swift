import Foundation
import Security

/// Why an update couldn't be installed, in words for the owner.
public enum MacAppUpdateFailure: Error, Equatable {
  case download, mount, copy, signature, notarization, identity, folder, swap, busy, current, cache

  public var reason: String {
    switch self {
    case .download: "the download didn’t finish or didn’t match the release"
    case .mount: "the installer couldn’t be opened"
    case .copy: "the new app couldn’t be copied"
    case .signature: "the new app isn’t signed by Shellbell’s developer"
    case .notarization: "macOS didn’t accept the new app"
    case .identity: "the new app isn’t the version that was offered"
    case .folder: "Shellbell can’t replace itself in its folder"
    case .swap: "the new version couldn’t be put in place, so this version is still installed"
    case .busy: "another copy of Shellbell is installing an update"
    case .current: "this Mac already has this version or a newer one"
    case .cache: "Shellbell’s folder for downloads isn’t set up as expected"
    }
  }

  /// Installing by hand from the download can still work.
  public var downloadHelps: Bool { ![.busy, .current].contains(self) }
}

/// Checks that an app is this app's next build before it replaces this one: signed with the same
/// identity (the running app's designated requirement), accepted by Gatekeeper as notarized, and
/// exactly the version and build that were offered.
public enum MacAppUpdateCheck {
  /// The running app's designated requirement: its bundle identifier and Developer ID team.
  public static func requirement(of app: URL) -> SecRequirement? {
    var code: SecStaticCode?
    var requirement: SecRequirement?
    guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code,
      SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess
    else { return nil }
    return requirement
  }

  public static func verify(
    app: URL, requirement: SecRequirement, bundleID: String, version: String, build: Int,
    notarized: (URL) -> Bool = assessNotarized
  ) throws {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code
    else { throw MacAppUpdateFailure.signature }
    let flags = SecCSFlags(
      rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
    guard SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess else {
      throw MacAppUpdateFailure.signature
    }
    let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
    guard info?["CFBundleIdentifier"] as? String == bundleID,
      info?["CFBundleShortVersionString"] as? String == version,
      info?["CFBundleVersion"] as? String == String(build)
    else { throw MacAppUpdateFailure.identity }
    guard notarized(app) else { throw MacAppUpdateFailure.notarization }
  }

  /// Gatekeeper's own answer, as when the app is first opened. Bounded: an online check that
  /// stalls counts as a refusal after two minutes.
  public static func assessNotarized(_ app: URL) -> Bool {
    assess(
      "/usr/sbin/spctl", ["--assess", "--type", "execute", "-vv", app.path], timeout: 120
    ) { $0.contains("source=Notarized Developer ID") }
  }
  static func assess(
    _ tool: String, _ arguments: [String], timeout: TimeInterval, accept: (String) -> Bool
  ) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = arguments
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    process.standardInput = FileHandle.nullDevice
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"]
    guard (try? process.run()) != nil else { return false }
    let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
    let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    process.waitUntilExit()
    deadline.cancel()
    return process.terminationReason == .exit && process.terminationStatus == 0 && accept(text)
  }
}

/// Replaces the app once it has quit. Runs as this app's own executable in a hidden mode, so it
/// outlives the app and can swap the two apps in one step.
///
/// The checked copy and the installed app sit in the same folder and trade places atomically, so
/// a complete app is installed at every moment, whatever interrupts the swap. Then the new app is
/// opened; if it can't be, the two trade back and the old one is opened instead. Only once the new
/// app is open does the old one go to the Trash. A failure is recorded so the reopened app can say
/// the update wasn't installed. The swap holds the install lock, inherited as its standard input,
/// until it exits, so no other copy of the app installs or cleans up until it is done; the opened
/// app's cleanup waits for it.
public enum MacAppSwap {
  /// Written in the update folder when the swap fails; read and removed at the next launch.
  public static let failureRecord = "update-failed"
  /// The hidden mode's first argument.
  public static let argument = "--apply-update"

  public enum Outcome: Int32 {
    case installed = 0, appStillRunning = 2, notSwapped = 3, notOpened = 4
  }

  /// `staged` and `target` must be in the same folder.
  public static func apply(
    pid: Int32, staged: URL, target: URL, trash: URL, record: URL,
    open: (URL) -> Bool = openApp, wait: TimeInterval = 300
  ) -> Outcome {
    let files = FileManager.default
    let deadline = Date().addingTimeInterval(wait)
    while kill(pid, 0) == 0 || errno == EPERM {
      guard Date() < deadline else {
        try? files.removeItem(at: staged)
        return .appStillRunning
      }
      usleep(100_000)
    }
    func failed(_ outcome: Outcome) -> Outcome {
      try? files.removeItem(at: staged)
      files.createFile(atPath: record.path, contents: Data("swap\n".utf8))
      _ = open(target)
      return outcome
    }
    guard renamex_np(staged.path, target.path, UInt32(RENAME_SWAP)) == 0 else {
      return failed(.notSwapped)
    }
    // From here `staged` holds the old app.
    guard open(target) else {
      // The new app is in place but won't open: put the old one back and open that.
      guard renamex_np(staged.path, target.path, UInt32(RENAME_SWAP)) == 0 else {
        files.createFile(atPath: record.path, contents: Data("swap\n".utf8))
        return .notOpened
      }
      return failed(.notOpened)
    }
    // Never into something already there; if it can't go to the Trash, it is removed.
    if renamex_np(staged.path, trash.path, UInt32(RENAME_EXCL)) != 0 {
      try? files.removeItem(at: staged)
    }
    return .installed
  }

  /// Opens an app as Finder would, and says whether macOS accepted it.
  public static func openApp(_ app: URL) -> Bool {
    MacAppUpdateCheck.assess("/usr/bin/open", [app.path], timeout: 60) { _ in true }
  }

  /// Where the old app goes: the owner's Trash, under a name that says which version it was.
  /// If something is already there or it can't go there, the old app is removed instead.
  public static func trashDestination(home: String, version: String, build: String) -> URL {
    let trash = URL(fileURLWithPath: home).appendingPathComponent(".Trash")
    var candidate = trash.appendingPathComponent("Shellbell \(version) (\(build)).app")
    var n = 2
    while FileManager.default.fileExists(atPath: candidate.path) {
      candidate = trash.appendingPathComponent("Shellbell \(version) (\(build)) \(n).app")
      n += 1
    }
    return candidate
  }

  /// Starts the swap as this app's own executable in its hidden mode, holding `lock`.
  public static func start(
    pid: Int32, staged: URL, target: URL, trash: URL, workRoot: URL, lock: Int32,
    executable: URL? = Bundle.main.executableURL
  ) throws -> Process {
    guard let executable else { throw MacAppUpdateFailure.swap }
    let process = Process()
    process.executableURL = executable
    process.arguments = [
      argument, String(pid), staged.path, target.path, trash.path,
      workRoot.appendingPathComponent(failureRecord).path,
    ]
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"]
    process.standardInput =
      lock >= 0 ? FileHandle(fileDescriptor: lock, closeOnDealloc: false) : FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    return process
  }
}
