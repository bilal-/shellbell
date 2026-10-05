import Darwin
import Foundation
import ShellbellCore

@MainActor enum ServiceLauncher {
  static func plan(mode: String? = nil) throws -> LaunchPlan {
    let bundle = try ServiceAPI.admittedBundle()
    let account = try LaunchPlan.account()
    let plan = try LaunchPlan(
      bundle: bundle, home: account.home, user: account.user, serviceMode: mode)
    try plan.validateFiles()
    return plan
  }
  static func run(_ mode: String) throws {
    if mode == "desktop" {
      var info = stat()
      guard fstat(3, &info) == 0,
        (info.st_mode & S_IFMT) == S_IFIFO || (info.st_mode & S_IFMT) == S_IFSOCK,
        fcntl(3, F_SETFD, 0) == 0
      else { throw BridgeFailure.unavailable }
    }
    let plan = try plan(mode: mode)
    let argv = ([plan.executable] + plan.arguments).map { strdup($0) } + [nil]
    let envp =
      plan.environment.sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { for pointer in argv + envp { free(pointer) } }
    guard chdir(plan.home) == 0 else { throw BridgeFailure.unavailable }
    // Replacing this process preserves launchd's PID as the actual engine PID.
    argv.withUnsafeBufferPointer { args in
      envp.withUnsafeBufferPointer { environment in
        _ = execve(plan.executable, args.baseAddress!, environment.baseAddress!)
      }
    }
    throw BridgeFailure.unavailable
  }
}
