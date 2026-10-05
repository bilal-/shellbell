import Foundation

public enum StartConsent {
  public static func detail(mode: String, migrateLegacy: Bool) -> String {
    (migrateLegacy ? "This transfers the CLI setup and preserves its devices and identity. " : "")
      + (mode == "persistent"
        ? "The service will start now and at future logins, subject to macOS approval in Login Items."
        : "The service will run for this login and remain running if you quit the menu bar app.")
  }
}
