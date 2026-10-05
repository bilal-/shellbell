import Darwin
import Foundation

/// Internal subprocess boundary, never exposed through helper IPC. The caller
/// supplies only the fixed system pmset executable and its fixed argument sets.
enum BoundedPowerCommand {
  enum Failure: Error { case launch(Int32), io(Int32), timedOut, outputLimit, exit(Int32), invalid }
  static func run(
    executable: String, arguments: [String], timeout: TimeInterval = 5,
    limit: Int = 65536
  ) throws -> Data {
    guard executable.hasPrefix("/"), timeout.isFinite, timeout > 0, limit > 0,
      !([executable] + arguments).contains(where: { $0.utf8.contains(0) })
    else { throw Failure.invalid }
    var descriptors: [Int32] = [-1, -1]
    guard pipe(&descriptors) == 0 else { throw Failure.io(errno) }
    let input = descriptors[0]
    let output = descriptors[1]
    defer { close(input) }
    guard fcntl(input, F_SETFL, O_NONBLOCK) == 0,
      fcntl(input, F_SETFD, FD_CLOEXEC) == 0, fcntl(output, F_SETFD, FD_CLOEXEC) == 0
    else {
      close(output)
      throw Failure.io(errno)
    }
    var actions: posix_spawn_file_actions_t?
    let initialized = posix_spawn_file_actions_init(&actions)
    guard initialized == 0 else {
      close(output)
      throw Failure.launch(initialized)
    }
    defer { posix_spawn_file_actions_destroy(&actions) }
    let setup = [
      posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0),
      posix_spawn_file_actions_adddup2(&actions, output, STDOUT_FILENO),
      posix_spawn_file_actions_adddup2(&actions, output, STDERR_FILENO),
      posix_spawn_file_actions_addclose(&actions, input),
      posix_spawn_file_actions_addclose(&actions, output),
    ]
    guard setup.allSatisfy({ $0 == 0 }) else {
      close(output)
      throw Failure.launch(setup.first { $0 != 0 }!)
    }
    let argv = ([executable] + arguments).map { strdup($0) } + [nil]
    let environmentStrings: [String] = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=C"]
    let env = environmentStrings.map { strdup($0) } + [nil]
    defer { for pointer in argv + env { free(pointer) } }
    var pid: pid_t = 0
    let result = argv.withUnsafeBufferPointer { args in
      env.withUnsafeBufferPointer { environment in
        posix_spawn(&pid, executable, &actions, nil, args.baseAddress!, environment.baseAddress!)
      }
    }
    close(output)
    guard result == 0 else { throw Failure.launch(result) }
    var reaped = false
    defer {
      if !reaped {
        // We have not reaped this child, so its PID cannot have been reused.
        _ = kill(pid, SIGKILL)
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
      }
    }
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    var captured = Data()
    var buffer = [UInt8](repeating: 0, count: 8192)
    var eof = false
    var status: Int32 = 0
    while true {
      // One bounded read per loop ensures continuous output cannot starve expiry.
      if !eof {
        let count = buffer.withUnsafeMutableBytes { Darwin.read(input, $0.baseAddress!, $0.count) }
        if count > 0 {
          guard count <= limit - captured.count else { throw Failure.outputLimit }
          captured.append(contentsOf: buffer.prefix(count))
        } else if count == 0 {
          eof = true
        } else if errno != EAGAIN && errno != EINTR {
          throw Failure.io(errno)
        }
      }
      if !reaped {
        let observed = waitpid(pid, &status, WNOHANG)
        if observed == pid {
          reaped = true
        } else if observed < 0 && errno != EINTR {
          if errno == ECHILD { reaped = true }
          throw Failure.io(errno)
        }
      }
      if reaped && eof {
        guard status == 0 else { throw Failure.exit(status) }
        return captured
      }
      guard ProcessInfo.processInfo.systemUptime < deadline else { throw Failure.timedOut }
      var descriptor = pollfd(fd: eof ? -1 : input, events: Int16(POLLIN), revents: 0)
      if poll(&descriptor, 1, 10) < 0 && errno != EINTR { throw Failure.io(errno) }
    }
  }
}
