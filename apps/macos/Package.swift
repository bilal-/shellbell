// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Shellbell",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "Shellbell", targets: ["Shellbell"]),
    .executable(name: "ShellbellPowerHelper", targets: ["ShellbellPowerHelper"]),
  ],
  targets: [
    .target(name: "ShellbellCore"),
    .target(name: "ShellbellPower", dependencies: ["ShellbellCore"]),
    .executableTarget(name: "Shellbell", dependencies: ["ShellbellCore", "ShellbellPower"]),
    .executableTarget(name: "ShellbellPowerHelper", dependencies: ["ShellbellCore", "ShellbellPower"]),
    .testTarget(
      name: "ShellbellCoreTests", dependencies: ["ShellbellCore", "ShellbellPower"],
      path: "Tests", exclude: ["Fixtures"]),
  ]
)
