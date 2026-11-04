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
  private let startSwap: (_ staged: URL, _ target: URL, _ lock: Int32) throws -> Process
  private let quit: () -> Void

  /// The installer at work, across every settings window: one install at a time, because each
  /// uses the same copy beside the app. Held here, not by its window, so closing Settings or
  /// switching sections can't drop an update that is waiting for Quit.
  private static var active: MacAppInstaller?
  /// The installer last used, so a settings window opened later shows how its install is going,
  /// or why it failed, instead of starting over.
  public private(set) static var current: MacAppInstaller?
  /// The last update's swap failed after quitting; the next installer starts by saying so.
  private static var swapFailedLastTime = false
  /// A checked update waiting for this quit.
  private var ready: URL?

  public init(
    target: URL, workRoot: URL, steps: any MacAppInstallSteps,
    startSwap: @escaping (_ staged: URL, _ target: URL, _ lock: Int32) throws -> Process,
    quit: @escaping () -> Void
  ) {
    self.target = target
    self.workRoot = workRoot
    self.steps = steps
    self.startSwap = startSwap
    self.quit = quit
    stagedApp = Self.newStagedApp(target)
    if Self.swapFailedLastTime {
      Self.swapFailedLastTime = false
      state = .failed(.swap)
    }
  }

  /// The new app is copied beside this one, so moving it into place can't fail half-way. Each
  /// install has its own name, so the swap moves exactly the copy that was checked.
  public private(set) var stagedApp: URL
  nonisolated private static let stagedPrefix = ".Shellbell-update-"
  private static func newStagedApp(_ target: URL) -> URL {
    target.deletingLastPathComponent().appendingPathComponent(
      stagedPrefix + UUID().uuidString + ".app")
  }

  /// Held from the start of an install until it fails, is cancelled or this app exits, so a
  /// second copy of the app can't install, or clean up, at the same time.
  private static var lock: Int32 = -1
  /// How long an install waits for the lock, which cleanup at launch holds for a few seconds.
  static var lockWait: TimeInterval = 20
  enum LockFailure: Error, Sendable { case busy, folder }
  /// The update folder must be this user's own private folder, never a link to somewhere else:
  /// cleanup removes what it finds there.
  nonisolated private static func takeLock(_ workRoot: URL, wait: TimeInterval) -> Result<
    Int32, LockFailure
  > {
    let path = workRoot.path
    if mkdir(path, 0o700) != 0 && errno != EEXIST {
      try? FileManager.default.createDirectory(
        at: workRoot.deletingLastPathComponent(), withIntermediateDirectories: true)
      _ = mkdir(path, 0o700)
    }
    var info = stat()
    guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(),
      info.st_mode & 0o077 == 0
    else { return .failure(.folder) }
    let fd = open(
      workRoot.appendingPathComponent("install.lock").path,
      O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return .failure(.folder) }
    let deadline = Date().addingTimeInterval(wait)
    while flock(fd, LOCK_EX | LOCK_NB) != 0 {
      guard Date() < deadline else {
        close(fd)
        return .failure(.busy)
      }
      usleep(100_000)
    }
    return .success(fd)
  }
  private static func releaseLock() {
    if lock >= 0 { close(lock) }
    lock = -1
  }

  /// At launch: removes what an install interrupted by a quit or crash left behind, unless
  /// another copy of the app is installing right now. Returns whether the last update's swap
  /// failed, so the app can say this version is still installed. Waits a little for the lock: a
  /// swap that just opened this app holds it until it has finished.
  nonisolated public static func cleanUpAtLaunch(
    workRoot: URL, target: URL, wait: TimeInterval = 60
  ) -> Bool {
    guard case .success(let fd) = takeLock(workRoot, wait: wait) else { return false }
    defer { close(fd) }
    let record = workRoot.appendingPathComponent(MacAppSwap.failureRecord)
    let failed = FileManager.default.fileExists(atPath: record.path)
    try? FileManager.default.removeItem(at: record)
    removeLeftovers(workRoot: workRoot, target: target)
    return failed
  }
  /// The installer a settings window shows: the one already in use, or a new one that later
  /// windows share.
  public static func shared(_ make: () -> MacAppInstaller) -> MacAppInstaller {
    if let current { return current }
    let installer = make()
    current = installer
    return installer
  }
  static func resetForTests() {
    current = nil
    swapFailedLastTime = false
  }
  /// The swap after the last quit failed: the updates view says so, whether it is open already
  /// or opens later.
  public static func swapFailed() {
    if let current, !current.busy {
      current.state = .failed(.swap)
    } else {
      swapFailedLastTime = true
    }
  }

  public func install(version: String, build: Int) {
    guard !busy, Self.active == nil else { return }
    guard FileManager.default.isWritableFile(atPath: target.deletingLastPathComponent().path) else {
      state = .failed(.folder)
      return
    }
    Self.active = self
    Self.current = self
    stagedApp = Self.newStagedApp(target)
    state = .downloading
    let workRoot = workRoot
    let target = target
    let wait = Self.lockWait
    Task {
      // Off the main thread: waiting for the lock, and detaching what an earlier install left.
      let locked = await Task.detached {
        let locked = Self.takeLock(workRoot, wait: wait)
        if case .success = locked { Self.removeLeftovers(workRoot: workRoot, target: target) }
        return locked
      }.value
      switch locked {
      case .success(let fd):
        Self.lock = fd
        await run(version: version, build: build)
      case .failure(let failure):
        state = .failed(failure == .busy ? .busy : .cache)
        Self.active = nil
      }
    }
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
      // Checked under the lock: another copy of the app may have updated this one since the
      // offer was made, and an update never installs an older build over a newer one.
      let info = NSDictionary(contentsOf: target.appendingPathComponent("Contents/Info.plist"))
      guard let installed = (info?["CFBundleVersion"] as? String).flatMap(Int.init) else {
        throw MacAppUpdateFailure.folder
      }
      guard installed < build else { throw MacAppUpdateFailure.current }
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
      Self.releaseLock()
    }
  }

  /// The app is quitting for certain: start the process that swaps in the checked update once the
  /// app has exited. Returns whether one was started.
  @discardableResult public static func quitting() -> Bool {
    guard let installer = active else { return false }
    active = nil
    // Quit came mid-download or mid-check: its steps end with the app (OwnedProcesses), and the
    // next launch removes what they left. The lock is released as this app exits.
    guard let staged = installer.ready else { return false }
    installer.ready = nil
    // The swap moves this copy within its five-minute wait; dated now, cleanup by another copy of
    // the app (which waits for fifteen) can never remove it mid-move, however long Quit took.
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: staged.path)
    do {
      // The swap holds the lock from here, so no other copy of the app installs before it ends.
      _ = try installer.startSwap(staged, installer.target, lock)
      return true
    } catch {
      // Nothing will reopen the app; the next launch says the update wasn't installed.
      try? FileManager.default.removeItem(at: staged)
      FileManager.default.createFile(
        atPath: installer.workRoot.appendingPathComponent(MacAppSwap.failureRecord).path,
        contents: Data("swap\n".utf8))
      return false
    }
  }

  /// Detaches any installer an interrupted install left open under `workRoot`, and removes its
  /// folders and any copy beside the app no swap is waiting for (or an old app a swap couldn't
  /// move to the Trash). Called only under the install lock. Bounded: each detach gets ten
  /// seconds.
  nonisolated static func removeLeftovers(workRoot: URL, target: URL) {
    let files = FileManager.default
    for folder in (try? files.contentsOfDirectory(at: workRoot, includingPropertiesForKeys: nil))
      ?? []
    where !["install.lock", MacAppSwap.failureRecord].contains(folder.lastPathComponent) {
      let mountPoint = folder.appendingPathComponent("installer")
      if let here = try? files.attributesOfItem(atPath: mountPoint.path)[.systemNumber] as? Int,
        let parent = try? files.attributesOfItem(atPath: folder.path)[.systemNumber] as? Int,
        here != parent
      {
        let detach = Process()
        detach.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        detach.arguments = ["detach", mountPoint.path, "-force"]
        detach.standardOutput = FileHandle.nullDevice
        detach.standardError = FileHandle.nullDevice
        if (try? detach.run()) != nil {
          let deadline = Date().addingTimeInterval(10)
          while detach.isRunning && Date() < deadline { usleep(50_000) }
          if detach.isRunning { detach.terminate() }
        }
        // Never delete through a mount that is still attached.
        let still = (try? files.attributesOfItem(atPath: mountPoint.path)[.systemNumber] as? Int)
        if still != nil && still != parent { continue }
      }
      try? files.removeItem(at: folder)
    }
    // A swap waits at most five minutes for the app to exit; an older copy is no one's. Never
    // the running app itself, whatever its name.
    let apps = target.deletingLastPathComponent()
    for item in (try? files.contentsOfDirectory(at: apps, includingPropertiesForKeys: nil)) ?? []
    where item.lastPathComponent.hasPrefix(stagedPrefix) && item.pathExtension == "app"
      && item.standardizedFileURL.path != target.standardizedFileURL.path
    {
      let modified = (try? files.attributesOfItem(atPath: item.path)[.modificationDate]) as? Date
      if (modified ?? .distantPast) < Date().addingTimeInterval(-15 * 60) {
        try? files.removeItem(at: item)
      }
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
    releaseLock()
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
      plan.executable, plan.arguments, environment: plan.environment, timeout: 3600)
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
        // Quitting mid-install ends it with the app, so nothing keeps writing into the folder.
        guard OwnedProcesses.run(process) else {
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
