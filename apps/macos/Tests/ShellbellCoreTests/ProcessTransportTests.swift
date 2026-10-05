import Foundation
import XCTest

@testable import ShellbellCore

@MainActor final class ProcessTransportTests: XCTestCase {
  func testRealNonblockingPipesFragmentAndEchoWithoutAnApplicationOrService() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let bin = root.appendingPathComponent("Shellbell.app/Contents/Helpers")
    try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    let node = bin.appendingPathComponent("node")
    try Data("#!/bin/sh\nexec /bin/cat\n".utf8).write(to: node)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
    let plan = try LaunchPlan(
      bundle: root.appendingPathComponent("Shellbell.app").path, home: root.path, user: "fixture")
    let transport = try ProcessBridgeTransport(plan: plan)
    defer { transport.close() }
    let echo = expectation(description: "entire bounded frame echoed over the real pipe")
    let payload = Data(repeating: 65, count: 65_536) + Data([10])
    var received = Data()
    transport.onData = { chunk in
      received.append(chunk)
      if received.count == payload.count { echo.fulfill() }
    }
    try transport.write(payload)
    await fulfillment(of: [echo], timeout: 5)
    XCTAssertEqual(received, payload)
    XCTAssertThrowsError(try transport.write(Data(repeating: 0, count: 262_145)))
  }
}
