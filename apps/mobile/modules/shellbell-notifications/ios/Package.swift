// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ShellbellNotificationCore",
    platforms: [.macOS(.v13), .iOS(.v15)],
    products: [.library(name: "ShellbellNotificationCore", targets: ["ShellbellNotificationCore"])],
    targets: [
        .target(name: "ShellbellNotificationCore", path: ".", exclude: ["Tests", "Package.swift", "ShellbellNotifications.podspec", "ShellbellNotificationsModule.swift", "NotificationService.swift", "NotificationStoreFactory.swift"], sources: ["NotificationCrypto.swift", "NotificationPolicy.swift", "NotificationStore.swift", "NotificationKeychainVault.swift", "NotificationPresentation.swift"]),
        .testTarget(name: "ShellbellNotificationCoreTests", dependencies: ["ShellbellNotificationCore"], path: "Tests")
    ]
)
