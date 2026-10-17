import Foundation

/// What macOS may ask once remote access is on, said in plain words before it asks.
public enum PermissionGuide {
  public struct Item: Equatable, Sendable {
    public let question: String
    public let reason: String
  }

  public static let heading = "macOS may ask you"

  public static let items: [Item] = [
    Item(
      question: "Control iTerm2",
      reason:
        "So your phone can show your iTerm2 tabs and type into them. Asked only once iTerm2's Python API is on. Shellbell controls no other app."
    ),
    Item(
      question: "Find devices on your local network",
      reason:
        "So your phone can connect straight to this Mac on the same Wi-Fi. Without it, your phone may not connect while it is on the same Wi-Fi."
    ),
  ]

  public static let footer =
    "Each is optional. Shellbell never asks for your Desktop, Documents or Downloads folders. Change any answer later in System Settings → Privacy & Security."
}
