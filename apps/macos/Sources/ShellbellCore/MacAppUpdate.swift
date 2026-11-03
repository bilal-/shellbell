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

/// Replaces the app once it has quit. Runs as its own process so it outlives the app.
///
/// Both moves that matter are renames within the app's own folder, so neither can stop half-way,
/// even when the app lives on another disk: the old app is set aside under a hidden name, the new
/// one takes its place, and only then does the old one go to the Trash. Whatever happens, the app
/// is opened again; a failure is recorded so the reopened app can say the update wasn't installed.
public enum MacAppSwap {
  /// Written in the update folder when the swap fails; read and removed at the next launch.
  public static let failureRecord = "update-failed"
  nonisolated static let asidePrefix = ".Shellbell-old-"

  /// Arguments: app process ID, staged new app, installed app, where the old app is set aside,
  /// its Trash destination, the failure record, opener. A move never lands inside something that
  /// already exists at its destination: each destination is checked to be free first.
  public static let script = #"""
    set -u
    pid=$1 staged=$2 target=$3 aside=$4 trash=$5 record=$6 opener=$7
    failed() { rm -rf "$staged"; echo swap > "$record"; "$opener" "$target"; exit "$1"; }
    i=0
    while kill -0 "$pid" 2>/dev/null; do
      i=$((i + 1))
      if [ "$i" -gt 3000 ]; then rm -rf "$staged"; exit 2; fi
      sleep 0.1
    done
    [ ! -e "$aside" ] && mv "$target" "$aside" || failed 3
    if [ -e "$target" ] || ! mv "$staged" "$target"; then
      [ -e "$target" ] || mv "$aside" "$target"
      failed 4
    fi
    [ -e "$trash" ] || mv "$aside" "$trash"
    "$opener" "$target"
    exit 0
    """#

  /// Where the old app goes: the owner's Trash, under a name that says which version it was.
  /// If it can't go there, it stays set aside and the next launch removes it.
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

  public static func start(
    pid: Int32, staged: URL, target: URL, trash: URL, workRoot: URL,
    opener: String = "/usr/bin/open"
  ) throws -> Process {
    let aside = target.deletingLastPathComponent().appendingPathComponent(
      asidePrefix + UUID().uuidString + ".app")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = [
      "-c", script, "shellbell-update", String(pid), staged.path, target.path, aside.path,
      trash.path, workRoot.appendingPathComponent(failureRecord).path, opener,
    ]
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    return process
  }
}
