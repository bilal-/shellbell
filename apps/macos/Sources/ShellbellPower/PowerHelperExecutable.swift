import Darwin

/// Notices when an app update replaces the file this helper was started from.
/// The running helper then has no signed code on disk, so macOS refuses its
/// replies to the app (errSecCSNoSuchCode) until launchd starts the new one.
@MainActor public final class PowerHelperExecutable {
  private struct Identity: Equatable {
    let device: dev_t
    let inode: ino_t
    let size: off_t
    let seconds: Int
    let nanoseconds: Int
  }
  private let path: String
  private let original: Identity?
  private var candidate: Identity?

  public init(path: String) {
    self.path = path
    original = Self.identity(path)
  }

  /// True once a different file has stayed unchanged across two checks, so a
  /// copy still in progress is never mistaken for the finished update.
  public func replaced() -> Bool {
    guard let original, let current = Self.identity(path), current != original else {
      candidate = nil
      return false
    }
    defer { candidate = current }
    return candidate == current
  }

  private static func identity(_ path: String) -> Identity? {
    var info = stat()
    guard stat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { return nil }
    return Identity(
      device: info.st_dev, inode: info.st_ino, size: info.st_size,
      seconds: info.st_mtimespec.tv_sec, nanoseconds: info.st_mtimespec.tv_nsec)
  }
}
