import AppKit
import Foundation
import ShellbellCore

// Argument admission must precede NSApplication and all service APIs.
do {
  switch try EntryMode.parse(Array(CommandLine.arguments.dropFirst())) {
  case .help:
    print("Shellbell menu bar app\nUsage: Shellbell [--help | --version]")
  case .version:
    print(
      Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.1")
  case .serviceAPI(let verb):
    exit(ServiceAPI.run(verb))
  case .loginAPI(let verb):
    exit(LoginStartupAPI.run(verb))
  case .serviceRun(let mode):
    try ServiceLauncher.run(mode)
  case .ui:
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
  }
} catch {
  FileHandle.standardError.write(Data("Shellbell could not complete this operation.\n".utf8))
  exit(1)
}
