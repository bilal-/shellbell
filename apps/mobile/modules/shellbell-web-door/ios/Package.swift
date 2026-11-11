// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ShellbellWebDoorCore",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [.library(name: "ShellbellWebDoorCore", targets: ["ShellbellWebDoorCore"])],
    targets: [
        .target(
            name: "ShellbellWebDoorCore", path: ".",
            exclude: [
                "Package.swift", "ShellbellWebDoor.podspec", "ShellbellWebDoorModule.swift",
                "Tests",
            ],
            sources: ["WebDoorServer.swift", "TransportAead.swift"]),
        .testTarget(
            name: "ShellbellWebDoorCoreTests", dependencies: ["ShellbellWebDoorCore"], path: "Tests"
        ),
    ])
