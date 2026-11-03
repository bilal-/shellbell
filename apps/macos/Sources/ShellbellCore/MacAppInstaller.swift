import CryptoKit
import Foundation

/// The steps of installing an update, apart so the order and the cleanup can be tested.
public protocol MacAppInstallSteps: Sendable {
  /// Downloads the offered version's installer into `folder` and returns its path.
  func download(version: String, build: Int, folder: URL) async throws -> URL
  /// Opens the installer read-only at `mountPoint`.
  func mount(_ installer: URL, at mountPoint: URL) async throws
  func copy(_ app: URL, to staged: URL) async throws
  func verify(_ app: URL, version: String, build: Int) async throws
  func detach(_ mountPoint: URL) async
}

/// Installs an offered update from inside the app: download, check, then quit and swap.
/// The app quits the usual way, so remote access stops and keep-awake carries over to the new
/// build. Only once the app is certainly quitting does a separate process start, which replaces
/// the app after it exits and opens the new one. A quit that is cancelled discards the update.
@MainActor public final class MacAppInstaller: ObservableObject {
  public enum State: Equatable {
    case idle, downloading, checking, restarting
    case failed(MacAppUpdateFailure)
  }
  @Published public private(set) var state = State.idle
  public var busy: Bool { [.downloading, .checking, .restarting].contains(state) }

  private let target: URL
  private let workRoot: URL
  private let steps: any MacAppInstallSteps
  private let startSwap: (_ staged: URL, _ target: URL) throws -> Process
  private let quit: () -> Void

  /// The installer at work, across every settings window: one install at a time, because each
  /// uses the same copy beside the app.
  private static weak var active: MacAppInstaller?
  /// A checked update waiting for this quit.
  private var ready: URL?

  public init(
    target: URL, workRoot: URL, steps: any MacAppInstallSteps,
    startSwap: @escaping (_ staged: URL, _ target: URL) throws -> Process,
    quit: @escaping () -> Void
  ) {
    self.target = target
    self.workRoot = workRoot
    self.steps = steps
    self.startSwap = startSwap
    self.quit = quit
  }

  /// The new app is copied beside this one, so moving it into place can't fail half-way.
  public var stagedApp: URL {
    target.deletingLastPathComponent().appendingPathComponent(".Shellbell-update.app")
  }

  public func install(version: String, build: Int) {
    guard !busy, Self.active == nil else { return }
    guard FileManager.default.isWritableFile(atPath: target.deletingLastPathComponent().path) else {
      state = .failed(.folder)
      return
    }
    Self.active = self
    state = .downloading
    Task { await run(version: version, build: build) }
  }

  private func run(version: String, build: Int) async {
    let files = FileManager.default
    let folder = workRoot.appendingPathComponent(UUID().uuidString)
    let mountPoint = folder.appendingPathComponent("installer")
    let staged = stagedApp
    var mounted = false
    func cleanUp(keepStaged: Bool) async {
      if mounted { await steps.detach(mountPoint) }
      mounted = false
      try? files.removeItem(at: folder)
      if !keepStaged { try? files.removeItem(at: staged) }
    }
    do {
      do {
        try files.createDirectory(
          at: mountPoint, withIntermediateDirectories: true,
          attributes: [.posixPermissions: 0o700])
        try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder.path)
      } catch { throw MacAppUpdateFailure.download }
      let installer = try await steps.download(version: version, build: build, folder: folder)
      state = .checking
      try await steps.mount(installer, at: mountPoint)
      mounted = true
      try? files.removeItem(at: staged)
      try await steps.copy(mountPoint.appendingPathComponent("Shellbell.app"), to: staged)
      await steps.detach(mountPoint)
      mounted = false
      // Checked where it now lies, so what replaces this app is exactly what was checked.
      try await steps.verify(staged, version: version, build: build)
      await cleanUp(keepStaged: true)
      ready = staged
      state = .restarting
      quit()
    } catch {
      await cleanUp(keepStaged: false)
      state = .failed(error as? MacAppUpdateFailure ?? .download)
      Self.active = nil
    }
  }

  /// The app is quitting for certain: start the process that swaps in the checked update once the
  /// app has exited. Returns whether one was started.
  @discardableResult public static func quitting() -> Bool {
    guard let installer = active, let staged = installer.ready else { return false }
    installer.ready = nil
    do {
      _ = try installer.startSwap(staged, installer.target)
      return true
    } catch {
      try? FileManager.default.removeItem(at: staged)
      return false
    }
  }

  /// Quit was cancelled: discard the checked update, so nothing changes at a later quit.
  public static func quitCancelled() {
    guard let installer = active, installer.ready != nil || installer.state == .restarting else {
      return
    }
    if let staged = installer.ready { try? FileManager.default.removeItem(at: staged) }
    installer.ready = nil
    installer.state = .idle
    active = nil
  }
}

/// The real steps: the bundled CLI downloads and checks the published digest, `hdiutil` opens
/// the installer read-only, `ditto` copies the app, and the signature check runs on that copy.
public struct SystemMacAppInstallSteps: MacAppInstallSteps {
  let bundle: String
  let home: String
  let user: String
  let bundleID: String

  public init(bundle: String, home: String, user: String, bundleID: String) {
    self.bundle = bundle
    self.home = home
    self.user = user
    self.bundleID = bundleID
  }

  public func download(version: String, build: Int, folder: URL) async throws -> URL {
    guard
      let plan = try? LaunchPlan(
        bundle: bundle, home: home, user: user, updateDownload: (version, folder.path)),
      (try? plan.validateFiles()) != nil
    else { throw MacAppUpdateFailure.download }
    let result = await Self.run(
      plan.executable, plan.arguments, environment: plan.environment, timeout: 600)
    struct Report: Decodable {
      let schemaVersion: Int
      let version: String
      let buildNumber: Int
      let sha256: String
      let path: String
    }
    guard result.status == 0,
      let report = try? JSONDecoder().decode(Report.self, from: result.output),
      report.schemaVersion == 1, report.version == version, report.buildNumber == build,
      URL(fileURLWithPath: report.path).deletingLastPathComponent().path == folder.path,
      let data = try? Data(contentsOf: URL(fileURLWithPath: report.path), options: .mappedIfSafe),
      SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == report.sha256
    else { throw MacAppUpdateFailure.download }
    return URL(fileURLWithPath: report.path)
  }

  public func mount(_ installer: URL, at mountPoint: URL) async throws {
    let result = await Self.run(
      "/usr/bin/hdiutil",
      [
        "attach", installer.path, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint",
        mountPoint.path,
      ], timeout: 120)
    guard result.status == 0 else { throw MacAppUpdateFailure.mount }
  }

  public func copy(_ app: URL, to staged: URL) async throws {
    let result = await Self.run("/usr/bin/ditto", [app.path, staged.path], timeout: 300)
    guard result.status == 0 else { throw MacAppUpdateFailure.copy }
  }

  /// Off the main thread: Gatekeeper's check can take a few seconds.
  public func verify(_ app: URL, version: String, build: Int) async throws {
    let bundle = self.bundle
    let bundleID = self.bundleID
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      DispatchQueue.global().async {
        do {
          guard let requirement = MacAppUpdateCheck.requirement(of: URL(fileURLWithPath: bundle))
          else { throw MacAppUpdateFailure.signature }
          try MacAppUpdateCheck.verify(
            app: app, requirement: requirement, bundleID: bundleID, version: version, build: build)
          continuation.resume()
        } catch { continuation.resume(throwing: error) }
      }
    }
  }

  public func detach(_ mountPoint: URL) async {
    _ = await Self.run("/usr/bin/hdiutil", ["detach", mountPoint.path, "-force"], timeout: 60)
  }

  /// Runs a fixed tool with a bounded wait; output is capped at 64 KiB.
  static func run(
    _ executable: String, _ arguments: [String],
    environment: [String: String] = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C"],
    timeout: TimeInterval
  ) async -> (status: Int32, output: Data) {
    await withCheckedContinuation { continuation in
      DispatchQueue.global().async {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else {
          continuation.resume(returning: (-1, Data()))
          return
        }
        let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
        var data = Data()
        while true {
          let chunk = output.fileHandleForReading.availableData
          if chunk.isEmpty { break }
          if data.count < 64 * 1024 { data.append(chunk.prefix(64 * 1024 - data.count)) }
        }
        process.waitUntilExit()
        deadline.cancel()
        continuation.resume(
          returning: (process.terminationReason == .exit ? process.terminationStatus : -1, data))
      }
    }
  }
}
