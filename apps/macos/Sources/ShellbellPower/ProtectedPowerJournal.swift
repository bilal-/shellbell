import Darwin
import Foundation
import ShellbellCore

/// Descriptor-relative operations never follow a path component or replace an unsafe record.
@MainActor public final class ProtectedPowerJournal: PowerJournalStore {
  public enum Failure: Error {
    case unsafePath, unsafeFile, invalidRecord
    case system(Int32)
  }
  private let directory: String
  private let ownerUID: uid_t
  private let name = "lease.json"
  private let limit = 8192
  public init(
    directory: String = "/Library/Application Support/Shellbell/Power", ownerUID: uid_t = 0
  ) {
    self.directory = directory
    self.ownerUID = ownerUID
  }

  private func directoryFD(create: Bool) throws -> Int32 {
    let components = directory.split(separator: "/", omittingEmptySubsequences: false)
    guard components.first == "", components.count > 1,
      components.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
      !directory.utf8.contains(0)
    else { throw Failure.unsafePath }
    var fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard fd >= 0 else { throw Failure.system(errno) }
    do {
      for (offset, component) in components.dropFirst().enumerated() {
        let part = String(component)
        var next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if next < 0 && errno == ENOENT && create {
          guard mkdirat(fd, part, 0o700) == 0 else { throw Failure.system(errno) }
          guard fsync(fd) == 0 else { throw Failure.system(errno) }
          next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        }
        guard next >= 0 else { throw Failure.unsafePath }
        close(fd)
        fd = next
        var st = stat()
        guard fstat(fd, &st) == 0 else { throw Failure.system(errno) }
        let final = offset == components.count - 2
        let stickyRoot = st.st_uid == 0 && st.st_mode & S_ISVTX != 0
        guard st.st_mode & S_IFMT == S_IFDIR,
          final
            ? st.st_uid == ownerUID && st.st_mode & 0o777 == 0o700
            : (st.st_uid == 0 || st.st_uid == ownerUID) && (st.st_mode & 0o022 == 0 || stickyRoot)
        else { throw Failure.unsafePath }
      }
      return fd
    } catch {
      close(fd)
      throw error
    }
  }

  private func read(at dir: Int32) throws -> PowerJournal? {
    let fd = openat(dir, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    if fd < 0 && errno == ENOENT { return nil }
    guard fd >= 0 else { throw Failure.unsafeFile }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, st.st_mode & S_IFMT == S_IFREG,
      st.st_uid == ownerUID, st.st_nlink == 1, st.st_mode & 0o777 == 0o600,
      st.st_size > 0, st.st_size <= limit
    else { throw Failure.unsafeFile }
    var bytes = [UInt8](repeating: 0, count: limit + 1)
    var count = 0
    while count < bytes.count {
      let n = bytes.withUnsafeMutableBytes {
        Darwin.read(fd, $0.baseAddress!.advanced(by: count), $0.count - count)
      }
      if n < 0 && errno == EINTR { continue }
      guard n >= 0 else { throw Failure.system(errno) }
      if n == 0 { break }
      count += n
    }
    guard count == Int(st.st_size), count <= limit,
      let value = try? JSONDecoder().decode(PowerJournal.self, from: Data(bytes.prefix(count))),
      value.isValid
    else { throw Failure.invalidRecord }
    return value
  }

  public func read() throws -> PowerJournal? {
    let dir = try directoryFD(create: true)
    defer { close(dir) }
    return try read(at: dir)
  }

  public func publish(_ journal: PowerJournal) throws {
    guard journal.isValid else { throw Failure.invalidRecord }
    let bytes = try JSONEncoder().encode(journal)
    guard bytes.count <= limit else { throw Failure.invalidRecord }
    let dir = try directoryFD(create: true)
    defer { close(dir) }
    _ = try read(at: dir)
    let temporary = ".lease-\(UUID().uuidString)"
    let fd = openat(dir, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw Failure.system(errno) }
    defer {
      close(fd)
      _ = unlinkat(dir, temporary, 0)
    }
    guard fchmod(fd, 0o600) == 0 else { throw Failure.system(errno) }
    var written = 0
    while written < bytes.count {
      let n = bytes.withUnsafeBytes {
        Darwin.write(fd, $0.baseAddress!.advanced(by: written), $0.count - written)
      }
      if n < 0 && errno == EINTR { continue }
      guard n > 0 else { throw Failure.system(errno) }
      written += n
    }
    guard fsync(fd) == 0 else { throw Failure.system(errno) }
    _ = try read(at: dir)
    guard renameat(dir, temporary, dir, name) == 0, fsync(dir) == 0 else {
      throw Failure.system(errno)
    }
  }

  public func clear() throws {
    let dir = try directoryFD(create: true)
    defer { close(dir) }
    guard try read(at: dir) != nil else { return }
    guard unlinkat(dir, name, 0) == 0, fsync(dir) == 0 else { throw Failure.system(errno) }
  }
}
