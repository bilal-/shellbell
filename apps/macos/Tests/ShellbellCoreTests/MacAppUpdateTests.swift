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
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent("Applications/Shellbell.app"),
      withIntermediateDirectories: true)
    swaps = []
  }
  override func tearDown() async throws {
    MacAppInstaller.quitCancelled()
    try? FileManager.default.removeItem(at: root)
  }
  private func installer(_ steps: FakeSteps, quit: @escaping () -> Void = {}) -> MacAppInstaller {
    MacAppInstaller(
      target: root.appendingPathComponent("Applications/Shellbell.app"),
      workRoot: root.appendingPathComponent("Caches"), steps: steps,
      startSwap: { [weak self] staged, target in
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
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: caches.path), [])
    // Nothing replaces the app until quitting is certain.
    XCTAssertTrue(swaps.isEmpty)
    XCTAssertTrue(MacAppInstaller.quitting())
    XCTAssertEqual(swaps.count, 1)
    XCTAssertEqual(swaps.first?.0.path, subject.stagedApp.path)
    XCTAssertFalse(MacAppInstaller.quitting(), "one swap per checked update")
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

  func testRefusesAFolderItCantReplaceItselfIn() throws {
    let folder = root.appendingPathComponent("Applications")
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: folder.path)
    defer {
      try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: folder.path)
    }
    let steps = FakeSteps()
    let subject = installer(steps)
    subject.install(version: "0.16.0", build: 58)
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
  /// Records what it was asked to open, standing in for `open`.
  private func opener() throws -> (path: String, log: URL) {
    let log = root.appendingPathComponent("opened")
    let script = root.appendingPathComponent("opener.sh")
    try Data("#!/bin/sh\necho \"$1\" > '\(log.path)'\n".utf8).write(to: script)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    return (script.path, log)
  }
  private func waitingApp() throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sleep")
    process.arguments = ["0.5"]
    try process.run()
    return process
  }

  func testWaitsForTheAppToQuitThenSwapsAndOpensTheNewOne() throws {
    let target = try app("Shellbell.app", marker: "old")
    let staged = try app(".Shellbell-update.app", marker: "new")
    let old = root.appendingPathComponent("Trash/Shellbell 0.15.1 (57).app")
    try FileManager.default.createDirectory(
      at: old.deletingLastPathComponent(), withIntermediateDirectories: true)
    let (openerPath, log) = try opener()
    let running = try waitingApp()
    let swap = try MacAppSwap.start(
      pid: running.processIdentifier, staged: staged, target: target, old: old, opener: openerPath)
    // Nothing moves while the app is still running.
    Thread.sleep(forTimeInterval: 0.2)
    XCTAssertEqual(try String(contentsOf: target.appendingPathComponent("marker")), "old")
    swap.waitUntilExit()
    XCTAssertEqual(swap.terminationStatus, 0)
    XCTAssertEqual(try String(contentsOf: target.appendingPathComponent("marker")), "new")
    XCTAssertEqual(try String(contentsOf: old.appendingPathComponent("marker")), "old")
    XCTAssertFalse(FileManager.default.fileExists(atPath: staged.path))
    XCTAssertEqual(try String(contentsOf: log).trimmingCharacters(in: .newlines), target.path)
  }

  func testPutsTheOldAppBackWhenTheNewOneCantBeMoved() throws {
    let target = try app("Shellbell.app", marker: "old")
    let staged = root.appendingPathComponent("missing.app")
    let old = root.appendingPathComponent("old.app")
    let (openerPath, log) = try opener()
    let swap = try MacAppSwap.start(
      pid: try waitingApp().processIdentifier, staged: staged, target: target, old: old,
      opener: openerPath)
    swap.waitUntilExit()
    XCTAssertEqual(swap.terminationStatus, 4)
    XCTAssertEqual(try String(contentsOf: target.appendingPathComponent("marker")), "old")
    XCTAssertEqual(try String(contentsOf: log).trimmingCharacters(in: .newlines), target.path)
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
    ) { XCTAssertNotNil($0 as? MacAppUpdateFailure) }
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
    // A changed file breaks the signature.
    try Data("changed".utf8).write(
      to: staged.appendingPathComponent("Contents/Resources/agent/dist/cli.js"))
    do {
      try await steps.verify(staged, version: version, build: build)
      XCTFail("a changed app passed")
    } catch { XCTAssertEqual(error as? MacAppUpdateFailure, .signature) }
  }
}
