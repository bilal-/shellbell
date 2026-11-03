import Foundation
import XCTest

@testable import ShellbellCore

private final class FakeSteps: MacAppInstallSteps, @unchecked Sendable {
  var calls: [String] = []
  var failAt: String?
  var verified: URL?
  func step(_ name: String) throws {
    calls.append(name)
    if failAt == name { throw MacAppUpdateFailure.signature }
  }
  func download(version: String, build: Int, folder: URL) async throws -> URL {
    try step("download")
    XCTAssertEqual(
      try FileManager.default.attributesOfItem(atPath: folder.path)[.posixPermissions] as? Int,
      0o700)
    let file = folder.appendingPathComponent("Shellbell-\(version)-arm64.dmg")
    try Data("dmg".utf8).write(to: file)
    return file
  }
  func mount(_ installer: URL, at mountPoint: URL) async throws { try step("mount") }
  func copy(_ app: URL, to staged: URL) async throws {
    try step("copy")
    XCTAssertEqual(app.lastPathComponent, "Shellbell.app")
    try FileManager.default.createDirectory(at: staged, withIntermediateDirectories: true)
  }
  func verify(_ app: URL, version: String, build: Int) async throws {
    try step("verify")
    verified = app
  }
  func detach(_ mountPoint: URL) async { calls.append("detach") }
}

@MainActor final class MacAppInstallerTests: XCTestCase {
  private var root: URL!
  private var swaps: [(URL, URL)] = []
  override func setUp() async throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try installedApp(build: 57)
    swaps = []
    MacAppInstaller.lockWait = 0.3
  }
  /// The app being updated, at the build it says it is.
  private func installedApp(build: Int) throws {
    let contents = root.appendingPathComponent("Applications/Shellbell.app/Contents")
    try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
    try (["CFBundleVersion": String(build)] as NSDictionary).write(
      to: contents.appendingPathComponent("Info.plist"))
  }
  override func tearDown() async throws {
    MacAppInstaller.quitCancelled()
    try? FileManager.default.removeItem(at: root)
  }
  private func installer(_ steps: FakeSteps, quit: @escaping () -> Void = {}) -> MacAppInstaller {
    MacAppInstaller(
      target: root.appendingPathComponent("Applications/Shellbell.app"),
      workRoot: root.appendingPathComponent("Caches"), steps: steps,
      startSwap: { [weak self] staged, target, _ in
        self?.swaps.append((staged, target))
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try process.run()
        return process
      }, quit: quit)
  }
  private func settle(_ installer: MacAppInstaller) async {
    for _ in 0..<200 where installer.busy && installer.state != .restarting {
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
  }

  func testChecksTheCopyItInstallsThenQuitsAndSwapsOnlyOnceQuitting() async throws {
    let steps = FakeSteps()
    var quit = false
    let subject = installer(steps) { quit = true }
    subject.install(version: "0.16.0", build: 58)
    await settle(subject)
    XCTAssertEqual(subject.state, .restarting)
    XCTAssertTrue(quit)
    XCTAssertEqual(steps.calls, ["download", "mount", "copy", "detach", "verify"])
    // The check ran on the copy beside the app, which is what the swap moves into place.
    XCTAssertEqual(
      steps.verified?.standardizedFileURL.path, subject.stagedApp.standardizedFileURL.path)
    XCTAssertTrue(FileManager.default.fileExists(atPath: subject.stagedApp.path))
    // The download folder is gone; only the checked copy is left for the swap.
    let caches = root.appendingPathComponent("Caches")
    XCTAssertEqual(
      try FileManager.default.contentsOfDirectory(atPath: caches.path), ["install.lock"])
    // Nothing replaces the app until quitting is certain.
    XCTAssertTrue(swaps.isEmpty)
    // However long Quit took, the copy is dated when the swap starts, so no cleanup takes it.
    try FileManager.default.setAttributes(
      [.modificationDate: Date().addingTimeInterval(-3600)], ofItemAtPath: subject.stagedApp.path)
    XCTAssertTrue(MacAppInstaller.quitting())
    XCTAssertEqual(swaps.count, 1)
    XCTAssertEqual(swaps.first?.0.path, subject.stagedApp.path)
    XCTAssertFalse(MacAppInstaller.quitting(), "one swap per checked update")
    let dated =
      try FileManager.default.attributesOfItem(atPath: subject.stagedApp.path)[.modificationDate]
      as? Date
    XCTAssertGreaterThan(dated ?? .distantPast, Date().addingTimeInterval(-60))
  }

  func testAFailedStepLeavesNothingBehindAndNeverQuits() async throws {
    for failAt in ["download", "mount", "copy", "verify"] {
      let steps = FakeSteps()
      steps.failAt = failAt
      var quit = false
      let subject = installer(steps) { quit = true }
      subject.install(version: "0.16.0", build: 58)
      await settle(subject)
      XCTAssertEqual(subject.state, .failed(.signature), failAt)
      XCTAssertFalse(quit, failAt)
      XCTAssertFalse(FileManager.default.fileExists(atPath: subject.stagedApp.path), failAt)
      XCTAssertFalse(MacAppInstaller.quitting(), failAt)
      if failAt != "download" && failAt != "mount" {
        XCTAssertTrue(steps.calls.contains("detach"), failAt)
      }
    }
    XCTAssertTrue(swaps.isEmpty)
  }

  func testACancelledQuitDiscardsTheUpdateSoALaterQuitChangesNothing() async throws {
    let subject = installer(FakeSteps())
    subject.install(version: "0.16.0", build: 58)
    await settle(subject)
    XCTAssertEqual(subject.state, .restarting)
    MacAppInstaller.quitCancelled()
    XCTAssertEqual(subject.state, .idle)
    XCTAssertFalse(FileManager.default.fileExists(atPath: subject.stagedApp.path))
    XCTAssertFalse(MacAppInstaller.quitting())
    XCTAssertTrue(swaps.isEmpty)
    // And it can be installed again.
    subject.install(version: "0.16.0", build: 58)
    await settle(subject)
    XCTAssertEqual(subject.state, .restarting)
  }

  func testOneInstallAtATimeAcrossSettingsWindows() async throws {
    let first = installer(FakeSteps())
    let secondSteps = FakeSteps()
    let second = installer(secondSteps)
    first.install(version: "0.16.0", build: 58)
    second.install(version: "0.16.0", build: 58)
    XCTAssertEqual(second.state, .idle)
    await settle(first)
    XCTAssertEqual(first.state, .restarting)
    XCTAssertEqual(secondSteps.calls, [])
  }

  func testKeepsAWaitingUpdateAfterItsWindowCloses() async throws {
    var subject: MacAppInstaller? = installer(FakeSteps())
    subject?.install(version: "0.16.0", build: 58)
    if let subject { await settle(subject) }
    weak let released = subject
    subject = nil
    XCTAssertNotNil(released, "the waiting update is still held")
    XCTAssertTrue(MacAppInstaller.quitting())
    XCTAssertEqual(swaps.count, 1)
  }

  func testLaunchRemovesWhatAnInterruptedInstallLeftButNotAWaitingCopy() throws {
    let files = FileManager.default
    let caches = root.appendingPathComponent("Caches")
    let target = root.appendingPathComponent("Applications/Shellbell.app")
    try files.createDirectory(
      at: caches.appendingPathComponent("interrupted/installer"), withIntermediateDirectories: true)
    let old = root.appendingPathComponent("Applications/.Shellbell-update-OLD.app")
    let fresh = root.appendingPathComponent("Applications/.Shellbell-update-NEW.app")
    try files.createDirectory(at: old, withIntermediateDirectories: true)
    try files.createDirectory(at: fresh, withIntermediateDirectories: true)
    try files.setAttributes(
      [.modificationDate: Date().addingTimeInterval(-3600)], ofItemAtPath: old.path)
    try files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: caches.path)
    XCTAssertFalse(MacAppInstaller.cleanUpAtLaunch(workRoot: caches, target: target))
    XCTAssertEqual(try files.contentsOfDirectory(atPath: caches.path), ["install.lock"])
    XCTAssertFalse(files.fileExists(atPath: old.path))
    // A swap may be about to move a recent copy into place.
    XCTAssertTrue(files.fileExists(atPath: fresh.path))
    XCTAssertTrue(files.fileExists(atPath: target.path))
  }

  func testEachInstallChecksAndSwapsItsOwnCopy() async throws {
    let subject = installer(FakeSteps())
    subject.install(version: "0.16.0", build: 58)
    await settle(subject)
    let first = subject.stagedApp
    MacAppInstaller.quitCancelled()
    subject.install(version: "0.16.0", build: 58)
    await settle(subject)
    XCTAssertNotEqual(first, subject.stagedApp)
    XCTAssertTrue(subject.stagedApp.lastPathComponent.hasPrefix(".Shellbell-update-"))
  }

  func testAnotherCopyOfTheAppInstallingBlocksThisOne() async throws {
    let caches = root.appendingPathComponent("Caches")
    try FileManager.default.createDirectory(
      at: caches, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    // Another process holds the install lock.
    let holder = Process()
    holder.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
    holder.arguments = [
      "-e",
      "use Fcntl qw(:flock); open(my $f, '>>', $ARGV[0]) or die; flock($f, LOCK_EX) or die; print \"ok\\n\"; $|=1; sleep 30",
      caches.appendingPathComponent("install.lock").path,
    ]
    let out = Pipe()
    holder.standardOutput = out
    try holder.run()
    defer { holder.terminate() }
    _ = out.fileHandleForReading.availableData
    let steps = FakeSteps()
    let subject = installer(steps)
    subject.install(version: "0.16.0", build: 58)
    await settle(subject)
    XCTAssertEqual(subject.state, .failed(.busy))
    XCTAssertEqual(steps.calls, [])
  }

  func testWaitsBrieflyForTheLockCleanupAtLaunchHolds() async throws {
    let caches = root.appendingPathComponent("Caches")
    try FileManager.default.createDirectory(
      at: caches, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let holder = Process()
    holder.executableURL = URL(fileURLWithPath: "/usr/bin/perl")
    holder.arguments = [
      "-e",
      "use Fcntl qw(:flock); open(my $f, '>>', $ARGV[0]) or die; flock($f, LOCK_EX) or die; print \"ok\\n\"; $|=1; select(undef, undef, undef, 0.3)",
      caches.appendingPathComponent("install.lock").path,
    ]
    let out = Pipe()
    holder.standardOutput = out
    try holder.run()
    _ = out.fileHandleForReading.availableData
    MacAppInstaller.lockWait = 5
    let subject = installer(FakeSteps())
    subject.install(version: "0.16.0", build: 58)
    await settle(subject)
    XCTAssertEqual(subject.state, .restarting)
  }

  func testNeverInstallsOverTheSameOrANewerBuild() async throws {
    // Another copy of the app updated it after this offer was made.
    try installedApp(build: 58)
    for build in [57, 58] {
      let steps = FakeSteps()
      var quit = false
      let subject = installer(steps) { quit = true }
      subject.install(version: "0.16.0", build: build)
      await settle(subject)
      XCTAssertEqual(subject.state, .failed(.current))
      XCTAssertEqual(steps.calls, [])
      XCTAssertFalse(quit)
    }
  }

  func testNeverCleansUpThroughALinkedUpdateFolder() async throws {
    let files = FileManager.default
    let elsewhere = root.appendingPathComponent("elsewhere")
    try files.createDirectory(at: elsewhere, withIntermediateDirectories: true)
    try Data("keep".utf8).write(to: elsewhere.appendingPathComponent("sentinel"))
    try files.createSymbolicLink(
      at: root.appendingPathComponent("Caches"), withDestinationURL: elsewhere)
    XCTAssertFalse(
      MacAppInstaller.cleanUpAtLaunch(
        workRoot: root.appendingPathComponent("Caches"),
        target: root.appendingPathComponent("Applications/Shellbell.app")))
    let steps = FakeSteps()
    let subject = installer(steps)
    subject.install(version: "0.16.0", build: 58)
    await settle(subject)
    XCTAssertEqual(subject.state, .failed(.cache))
    XCTAssertEqual(steps.calls, [])
    XCTAssertEqual(try files.contentsOfDirectory(atPath: elsewhere.path), ["sentinel"])
  }

  func testAWindowOpenedLaterShowsTheInstallInProgress() async throws {
    let subject = installer(FakeSteps())
    subject.install(version: "0.16.0", build: 58)
    XCTAssertTrue(MacAppInstaller.current === subject)
    await settle(subject)
  }

  func testLaunchSaysWhenTheLastSwapFailed() throws {
    let files = FileManager.default
    let caches = root.appendingPathComponent("Caches")
    let target = root.appendingPathComponent("Applications/Shellbell.app")
    try files.createDirectory(at: caches, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try Data("swap\n".utf8).write(to: caches.appendingPathComponent(MacAppSwap.failureRecord))
    XCTAssertTrue(MacAppInstaller.cleanUpAtLaunch(workRoot: caches, target: target))
    XCTAssertFalse(MacAppInstaller.cleanUpAtLaunch(workRoot: caches, target: target), "said once")
    MacAppInstaller.swapFailed()
    XCTAssertEqual(installer(FakeSteps()).state, .failed(.swap))
    XCTAssertEqual(installer(FakeSteps()).state, .idle)
  }

  func testLaunchNeverRemovesTheRunningAppWhateverItsName() throws {
    let files = FileManager.default
    let caches = root.appendingPathComponent("Caches")
    let running = root.appendingPathComponent("Applications/.Shellbell-update-A.app")
    try files.createDirectory(at: running, withIntermediateDirectories: true)
    try files.setAttributes(
      [.modificationDate: Date().addingTimeInterval(-3600)], ofItemAtPath: running.path)
    _ = MacAppInstaller.cleanUpAtLaunch(workRoot: caches, target: running)
    XCTAssertTrue(files.fileExists(atPath: running.path))
  }

  func testAFailedSwapShowsInAnOpenWindowToo() async throws {
    let subject = installer(FakeSteps())
    subject.install(version: "0.16.0", build: 58)
    await settle(subject)
    MacAppInstaller.quitCancelled()
    MacAppInstaller.swapFailed()
    XCTAssertEqual(subject.state, .failed(.swap))
  }

  func testRefusesAFolderItCantReplaceItselfIn() async throws {
    let folder = root.appendingPathComponent("Applications")
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: folder.path)
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
    }
    let steps = FakeSteps()
    let subject = installer(steps)
    subject.install(version: "0.16.0", build: 58)
    await settle(subject)
    XCTAssertEqual(subject.state, .failed(.folder))
    XCTAssertEqual(steps.calls, [])
  }
}

final class MacAppSwapTests: XCTestCase {
  private var root: URL!
  override func setUpWithError() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  }
  override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

  private func app(_ name: String, marker: String) throws -> URL {
    let url = root.appendingPathComponent(name)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    try Data(marker.utf8).write(to: url.appendingPathComponent("marker"))
    return url
  }
  private func marker(_ app: URL) -> String? {
    try? String(contentsOf: app.appendingPathComponent("marker"), encoding: .utf8)
  }
  /// A process that has already exited, standing in for the app once it has quit.
  private func quitApp() throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    try process.run()
    process.waitUntilExit()
    return process.processIdentifier
  }
  private var record: URL { root.appendingPathComponent(MacAppSwap.failureRecord) }
  private var trash: URL { root.appendingPathComponent("Shellbell 0.15.1 (57).app") }
  private var hidden: [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).filter {
      $0.hasPrefix(".")
    }
  }

  func testWaitsForTheAppToQuitThenSwapsOpensTheNewOneAndTrashesTheOld() throws {
    let target = try app("Shellbell.app", marker: "old")
    let staged = try app(".Shellbell-update-A.app", marker: "new")
    let running = Process()
    running.executableURL = URL(fileURLWithPath: "/bin/sleep")
    running.arguments = ["0.5"]
    try running.run()
    var opened: [String?] = []
    var released = false
    let started = Date()
    let outcome = MacAppSwap.apply(
      pid: running.processIdentifier, staged: staged, target: target, trash: trash,
      record: record, releaseLock: { released = true },
      open: { opened.append(self.marker($0)); return true })
    XCTAssertGreaterThan(Date().timeIntervalSince(started), 0.3, "waited for the app to quit")
    XCTAssertEqual(outcome, .installed)
    XCTAssertEqual(marker(target), "new")
    XCTAssertEqual(marker(trash), "old")
    XCTAssertEqual(opened, ["new"])
    XCTAssertTrue(released)
    XCTAssertEqual(hidden, [])
    XCTAssertFalse(FileManager.default.fileExists(atPath: record.path))
  }

  func testPutsTheOldAppBackAndSaysSoWhenTheNewOneWontOpen() throws {
    let target = try app("Shellbell.app", marker: "old")
    let staged = try app(".Shellbell-update-A.app", marker: "new")
    var opened: [String?] = []
    let outcome = MacAppSwap.apply(
      pid: try quitApp(), staged: staged, target: target, trash: trash, record: record,
      open: { opened.append(self.marker($0)); return opened.count > 1 })
    XCTAssertEqual(outcome, .notOpened)
    XCTAssertEqual(marker(target), "old")
    XCTAssertEqual(opened, ["new", "old"])
    XCTAssertEqual(hidden, [], "the copy that wouldn't open is removed")
    XCTAssertTrue(FileManager.default.fileExists(atPath: record.path))
  }

  func testLeavesTheAppAsItWasReopensItAndSaysSoWhenTheSwapFails() throws {
    let target = try app("Shellbell.app", marker: "old")
    let staged = root.appendingPathComponent(".Shellbell-update-missing.app")
    var opened: [String?] = []
    let outcome = MacAppSwap.apply(
      pid: try quitApp(), staged: staged, target: target, trash: trash, record: record,
      open: { opened.append(self.marker($0)); return true })
    XCTAssertEqual(outcome, .notSwapped)
    XCTAssertEqual(marker(target), "old")
    XCTAssertEqual(opened, ["old"])
    XCTAssertTrue(FileManager.default.fileExists(atPath: record.path))
  }

  func testNeverMovesTheOldAppIntoSomethingAlreadyInTheTrash() throws {
    let target = try app("Shellbell.app", marker: "old")
    let staged = try app(".Shellbell-update-A.app", marker: "new")
    try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
    let outcome = MacAppSwap.apply(
      pid: try quitApp(), staged: staged, target: target, trash: trash, record: record,
      open: { _ in true })
    XCTAssertEqual(outcome, .installed)
    XCTAssertEqual(marker(target), "new")
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: trash.path), [])
    XCTAssertEqual(hidden, [], "the old app is removed instead")
  }

  func testGivesUpAndKeepsTheAppIfItNeverQuits() throws {
    let target = try app("Shellbell.app", marker: "old")
    let staged = try app(".Shellbell-update-A.app", marker: "new")
    var opened = 0
    let outcome = MacAppSwap.apply(
      pid: getpid(), staged: staged, target: target, trash: trash, record: record,
      open: { _ in
        opened += 1
        return true
      }, wait: 0.2)
    XCTAssertEqual(outcome, .appStillRunning)
    XCTAssertEqual(marker(target), "old")
    XCTAssertEqual(opened, 0)
    XCTAssertEqual(hidden, [])
  }

  func testTheSwapHoldsTheInstallLockAfterTheAppExits() throws {
    let lockPath = root.appendingPathComponent("install.lock").path
    let fd = open(lockPath, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
    XCTAssertEqual(flock(fd, LOCK_EX | LOCK_NB), 0)
    // Stands in for the app's executable in its swap mode: holds standard input a moment.
    let helper = root.appendingPathComponent("helper.sh")
    try Data("#!/bin/sh\nsleep 1\n".utf8).write(to: helper)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helper.path)
    let swap = try MacAppSwap.start(
      pid: 1, staged: root.appendingPathComponent(".Shellbell-update-A.app"),
      target: root.appendingPathComponent("Shellbell.app"), trash: trash, workRoot: root,
      lock: fd, executable: helper)
    close(fd)  // The app has exited.
    let other = open(lockPath, O_RDWR | O_CLOEXEC)
    defer { close(other) }
    XCTAssertNotEqual(flock(other, LOCK_EX | LOCK_NB), 0, "another copy can't install yet")
    swap.waitUntilExit()
    XCTAssertEqual(flock(other, LOCK_EX | LOCK_NB), 0)
  }

  func testTheHiddenModeAcceptsOnlyACopyBesideTheInstalledApp() throws {
    let record = "/Users/a/Library/Caches/x/Updates/update-failed"
    XCTAssertEqual(
      try EntryMode.parse([
        "--apply-update", "42", "/Applications/.Shellbell-update-A.app", "/Applications/Shellbell.app",
        "/Users/a/.Trash/Shellbell 0.15.1 (57).app", record,
      ]),
      .applyUpdate(
        pid: 42, staged: "/Applications/.Shellbell-update-A.app",
        target: "/Applications/Shellbell.app", trash: "/Users/a/.Trash/Shellbell 0.15.1 (57).app",
        record: record))
    for bad in [
      ["--apply-update", "42", "/tmp/.Shellbell-update-A.app", "/Applications/Shellbell.app", "/t.app", record],
      ["--apply-update", "42", "/Applications/Other.app", "/Applications/Shellbell.app", "/t.app", record],
      ["--apply-update", "x", "/Applications/.Shellbell-update-A.app", "/Applications/Shellbell.app", "/t.app", record],
      ["--apply-update", "42", "/Applications/.Shellbell-update-A.app", "/Applications/Shellbell.app", "/t.app", "/tmp/other"],
      ["--apply-update", "42", "/Applications/.Shellbell-update-A.app", "Shellbell.app", "/t.app", record],
    ] {
      XCTAssertThrowsError(try EntryMode.parse(bad), bad.joined(separator: " "))
    }
  }

  func testTrashNameSaysWhichVersionItWasAndNeverOverwrites() throws {
    let home = root.path
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent(".Trash/Shellbell 0.15.1 (57).app"),
      withIntermediateDirectories: true)
    XCTAssertEqual(
      MacAppSwap.trashDestination(home: home, version: "0.15.1", build: "57").lastPathComponent,
      "Shellbell 0.15.1 (57) 2.app")
  }
}

final class MacAppUpdateCheckTests: XCTestCase {
  func testAToolThatStallsCountsAsARefusal() {
    let started = Date()
    XCTAssertFalse(MacAppUpdateCheck.assess("/bin/sleep", ["30"], timeout: 0.3) { _ in true })
    XCTAssertLessThan(Date().timeIntervalSince(started), 5)
  }

  private let calculator = URL(fileURLWithPath: "/System/Applications/Calculator.app")

  func testRefusesAnAppFromAnotherSigner() throws {
    // Any Apple-signed app stands in for "signed, but not by Shellbell's developer".
    let shellbell = try XCTUnwrap(
      SecRequirement.from(
        #"identifier "sh.bilal.shellbell.host" and anchor apple generic and certificate leaf[subject.OU] = "2CW9DK45CV""#
      ))
    XCTAssertThrowsError(
      try MacAppUpdateCheck.verify(
        app: calculator, requirement: shellbell, bundleID: "com.apple.calculator", version: "1.0.0",
        build: 1, notarized: { _ in true })
    ) { XCTAssertEqual($0 as? MacAppUpdateFailure, .signature) }
  }

  func testRefusesTheRightSignerAtAVersionThatWasntOffered() throws {
    let own = try XCTUnwrap(MacAppUpdateCheck.requirement(of: calculator))
    XCTAssertThrowsError(
      try MacAppUpdateCheck.verify(
        app: calculator, requirement: own, bundleID: "com.apple.calculator", version: "0.16.0",
        build: 58, notarized: { _ in true })
    ) { XCTAssertEqual($0 as? MacAppUpdateFailure, .identity) }
  }

  func testRefusesWhatGatekeeperRefuses() throws {
    let own = try XCTUnwrap(MacAppUpdateCheck.requirement(of: calculator))
    let info = try XCTUnwrap(
      NSDictionary(contentsOf: calculator.appendingPathComponent("Contents/Info.plist")))
    XCTAssertThrowsError(
      try MacAppUpdateCheck.verify(
        app: calculator, requirement: own, bundleID: "com.apple.calculator",
        version: try XCTUnwrap(info["CFBundleShortVersionString"] as? String),
        build: Int(try XCTUnwrap(info["CFBundleVersion"] as? String)) ?? -1,
        notarized: { _ in false })
    ) { XCTAssertEqual($0 as? MacAppUpdateFailure, .notarization) }
  }
}

extension SecRequirement {
  static func from(_ text: String) -> SecRequirement? {
    var requirement: SecRequirement?
    return SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess
      ? requirement : nil
  }
}

/// Runs the real steps on a published installer: SHELLBELL_UPDATE_DMG names the DMG,
/// SHELLBELL_UPDATE_VERSION and SHELLBELL_UPDATE_BUILD what it holds, checked against the app
/// installed at SHELLBELL_UPDATE_SIGNER. Skipped unless all are set.
final class MacAppRealInstallerTests: XCTestCase {
  func testAPublishedInstallerPassesEveryCheck() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let dmg = env["SHELLBELL_UPDATE_DMG"], let version = env["SHELLBELL_UPDATE_VERSION"],
      let build = env["SHELLBELL_UPDATE_BUILD"].flatMap(Int.init),
      let signer = env["SHELLBELL_UPDATE_SIGNER"]
    else { throw XCTSkip("set SHELLBELL_UPDATE_DMG, _VERSION, _BUILD and _SIGNER") }
    let steps = SystemMacAppInstallSteps(
      bundle: signer, home: NSHomeDirectory(), user: NSUserName(),
      bundleID: "sh.bilal.shellbell.host")
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let mountPoint = root.appendingPathComponent("installer")
    try FileManager.default.createDirectory(at: mountPoint, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try await steps.mount(URL(fileURLWithPath: dmg), at: mountPoint)
    let staged = root.appendingPathComponent("Shellbell.app")
    do {
      try await steps.copy(mountPoint.appendingPathComponent("Shellbell.app"), to: staged)
    } catch {
      await steps.detach(mountPoint)
      throw error
    }
    await steps.detach(mountPoint)
    try await steps.verify(staged, version: version, build: build)
    do {
      try await steps.verify(staged, version: version, build: build + 1)
      XCTFail("a build that wasn't offered passed")
    } catch {}
    // An install interrupted with the installer still open leaves nothing mounted.
    let work = root.appendingPathComponent("work")
    let interrupted = work.appendingPathComponent("interrupted/installer")
    try FileManager.default.createDirectory(at: interrupted, withIntermediateDirectories: true)
    try await steps.mount(URL(fileURLWithPath: dmg), at: interrupted)
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: interrupted.appendingPathComponent("Shellbell.app").path))
    MacAppInstaller.removeLeftovers(
      workRoot: work, target: root.appendingPathComponent("Shellbell.app"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: interrupted.path))
    // A changed file breaks the signature.
    try Data("changed".utf8).write(
      to: staged.appendingPathComponent("Contents/Resources/agent/dist/cli.js"))
    do {
      try await steps.verify(staged, version: version, build: build)
      XCTFail("a changed app passed")
    } catch { XCTAssertEqual(error as? MacAppUpdateFailure, .signature) }
  }
}
