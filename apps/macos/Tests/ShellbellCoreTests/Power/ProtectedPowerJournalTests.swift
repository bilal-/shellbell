import Darwin
import Foundation
import XCTest

@testable import ShellbellCore
@testable import ShellbellPower

final class ProtectedPowerJournalTests: XCTestCase {
  @MainActor private func fixture(_ test: (ProtectedPowerJournal, URL) throws -> Void) throws {
    let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
      .appendingPathComponent("shellbell-power-journal-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    guard let resolved = realpath(root.path, nil) else { throw CocoaError(.fileReadUnknown) }
    defer { free(resolved) }
    let canonical = URL(fileURLWithPath: String(cString: resolved))
    try test(ProtectedPowerJournal(directory: canonical.path, ownerUID: getuid()), canonical)
  }
  @MainActor func testRoundtripPrivateAtomicPublicationAndClear() throws {
    try fixture { store, root in
      XCTAssertNil(try store.read())
      var record = PowerJournal(leaseID: UUID(), ownerUID: 501, phase: .prepared)
      try store.publish(record)
      XCTAssertEqual(try store.read(), record)
      record.phase = .applied
      try store.publish(record)
      XCTAssertEqual(try store.read(), record)
      let attrs = try FileManager.default.attributesOfItem(
        atPath: root.appendingPathComponent("lease.json").path)
      XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["lease.json"])
      try store.clear()
      XCTAssertNil(try store.read())
    }
  }
  @MainActor func testSymlinkAndHardlinkRecordsAreNeverReadOverwrittenOrDeleted() throws {
    try fixture { store, root in
      let outside = root.appendingPathComponent("sentinel")
      let record = root.appendingPathComponent("lease.json")
      try Data("untouched".utf8).write(to: outside)
      XCTAssertEqual(symlink(outside.path, record.path), 0)
      XCTAssertThrowsError(try store.read())
      XCTAssertThrowsError(
        try store.publish(.init(leaseID: UUID(), ownerUID: 501, phase: .prepared)))
      XCTAssertThrowsError(try store.clear())
      try FileManager.default.removeItem(at: record)
      XCTAssertEqual(link(outside.path, record.path), 0)
      XCTAssertThrowsError(try store.read())
      XCTAssertThrowsError(try store.clear())
      XCTAssertEqual(try String(contentsOf: outside, encoding: .utf8), "untouched")
    }
  }
  @MainActor func testUnsafeDirectoryAndSymlinkParentAreRejected() throws {
    try fixture { store, root in
      XCTAssertEqual(chmod(root.path, 0o777), 0)
      XCTAssertThrowsError(
        try store.publish(.init(leaseID: UUID(), ownerUID: 501, phase: .prepared)))
      XCTAssertEqual(chmod(root.path, 0o700), 0)
      let alias = root.appendingPathComponent("alias")
      XCTAssertEqual(symlink(root.path, alias.path), 0)
      let viaAlias = ProtectedPowerJournal(directory: alias.path, ownerUID: getuid())
      XCTAssertThrowsError(try viaAlias.read())
    }
  }
  @MainActor func testTruncatedOversizedUnsafeAndInvalidRecordsFailClosed() throws {
    try fixture { store, root in
      let file = root.appendingPathComponent("lease.json")
      for data in [
        Data("{".utf8), Data(repeating: 65, count: 8193),
        Data(#"{"v":9,"ownerUID":0}"#.utf8),
      ] {
        try data.write(to: file)
        XCTAssertEqual(chmod(file.path, 0o600), 0)
        XCTAssertThrowsError(try store.read())
        XCTAssertThrowsError(try store.clear())
      }
      try FileManager.default.removeItem(at: file)
      try store.publish(.init(leaseID: UUID(), ownerUID: 501, phase: .prepared))
      XCTAssertEqual(chmod(file.path, 0o644), 0)
      XCTAssertThrowsError(try store.read())
      XCTAssertThrowsError(try store.clear())
    }
  }
}
