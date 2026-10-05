import Darwin
import Foundation
import XCTest

@testable import ShellbellCore

final class LaunchPlanTests: XCTestCase {
  func testLoginHelperModeIsSeparateAndStrict() throws {
    XCTAssertEqual(try EntryMode.parse(["--login-api", "status"]), .loginAPI("status"))
    XCTAssertEqual(try EntryMode.parse(["--login-api", "register"]), .loginAPI("register"))
    XCTAssertThrowsError(try EntryMode.parse(["--login-api", "launch"]))
    XCTAssertThrowsError(try EntryMode.parse(["--login-api", "register", "/tmp/other.app"]))
  }
  func testDesktopModeHasFixedServiceArguments() throws {
    XCTAssertEqual(try EntryMode.parse(["--service-run", "desktop"]), .serviceRun("desktop"))
    let plan = try LaunchPlan(bundle: "/Applications/Shellbell.app", home: "/Users/fixture", user: "fixture", serviceMode: "desktop")
    XCTAssertEqual(plan.arguments, ["/Applications/Shellbell.app/Contents/Resources/agent/dist/native-service.js", "desktop"])
  }
  func testFixedModesRefuseAnyAdditionalPathsBeforeUI() throws {
    XCTAssertEqual(try EntryMode.parse([]), .ui)
    XCTAssertEqual(try EntryMode.parse(["--service-run", "persistent"]), .serviceRun("persistent"))
    for args in [
      ["--service-api", "open-settings"], ["--service-run", "manual", "/tmp/script"],
      ["--help", "extra"], ["--unknown"],
    ] {
      XCTAssertThrowsError(try EntryMode.parse(args))
    }
  }
  func testBundlePathsAndEnvironmentNeverInheritNodeOrHomeOverrides() throws {
    let p = try LaunchPlan(
      bundle: "/Applications/Shellbell.app", home: "/Users/fixture", user: "fixture",
      serviceMode: "manual")
    XCTAssertEqual(p.executable, "/Applications/Shellbell.app/Contents/Helpers/node")
    XCTAssertEqual(
      p.arguments,
      ["/Applications/Shellbell.app/Contents/Resources/agent/dist/native-service.js", "manual"])
    XCTAssertEqual(p.environment["HOME"], "/Users/fixture")
    XCTAssertNil(p.environment["NODE_OPTIONS"])
    XCTAssertNil(p.environment["SHELLBELL_DIR"])
    XCTAssertThrowsError(
      try LaunchPlan(bundle: "/Applications/Other.app", home: "/Users/fixture", user: "fixture"))
  }
  func testBundleAdmissionRefusesSymlinksAndWritableHelpers() throws {
    let resolved = realpath(FileManager.default.temporaryDirectory.path, nil)!
    defer { free(resolved) }
    let root = URL(fileURLWithPath: String(cString: resolved)).appendingPathComponent(
      UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let file = root.appendingPathComponent("helper")
    try Data("fixture".utf8).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
    try LaunchPlan.validateFile(file.path)
    try FileManager.default.setAttributes([.posixPermissions: 0o722], ofItemAtPath: file.path)
    XCTAssertThrowsError(try LaunchPlan.validateFile(file.path))
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
    let link = root.appendingPathComponent("linked")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
    XCTAssertThrowsError(try LaunchPlan.validateFile(link.path))
  }
}
