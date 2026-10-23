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
      question: "Find devices on your local network",
      reason:
        "So your phone can connect straight to this Mac on the same Wi-Fi. Without it, your phone may not connect while it is on the same Wi-Fi."
    )
  ]

  /// Terminal questions belong to each terminal's card, where they are asked.
  public static let next =
    "Next, open Terminals to connect iTerm2, tmux or Herdr. Each one says what macOS will ask before it asks."

  public static let footer =
    "Terminal mirroring does not need access to your personal folders. Commands you run may trigger macOS permission prompts. Change any answer later in System Settings → Privacy & Security."
}
