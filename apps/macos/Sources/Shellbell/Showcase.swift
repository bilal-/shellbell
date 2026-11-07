#if DEBUG
  import AppKit
  import Foundation
  import ShellbellCore

  /// Answers the controller's requests from a JSON file of example replies, so the website's
  /// Mac screenshots show real windows with made-up names. Debug builds only: it never starts,
  /// reads or changes a service, a pairing or the power helper.
  @MainActor final class ShowcaseConnection: ControllerConnection {
    var onEvent: ((JSONValue) -> Void)?
    var onClosed: (() -> Void)?
    private(set) var isReady = false
    private let replies: [String: JSONValue]

    init(replies: [String: JSONValue]) { self.replies = replies }

    func connect(_ completion: @escaping (Result<JSONValue, BridgeFailure>) -> Void) {
      isReady = true
      completion(.success(.object([:])))
    }
    func request(
      _ command: String, args: JSONValue?,
      completion: @escaping (Result<JSONValue, BridgeFailure>) -> Void
    ) {
      // Changes answer with the status they would leave behind; nothing is changed.
      guard let reply = replies[command] ?? replies["status"] else {
        return completion(.failure(.unavailable))
      }
      DispatchQueue.main.async { completion(.success(reply)) }
    }
    func close() {
      isReady = false
      onClosed?()
    }
  }

  /// `SHELLBELL_SHOWCASE` names the replies file; `SHELLBELL_SHOWCASE_SHOW` the window section
  /// to open (`Settings`, `Notifications`, `Terminals`, `Devices`, `Pair Device`, `Diagnostics`).
  /// `SHELLBELL_SHOWCASE_HEIGHT` sets the window's height. Once it is drawn, the window is saved as a PNG to `SHELLBELL_SHOWCASE_READY` and the app
  /// quits.
  struct Showcase {
    let replies: [String: JSONValue]
    let show: String
    let ready: String?
    let keepAwake: Bool
    let height: Double

    static func fromEnvironment() -> Showcase? {
      let environment = ProcessInfo.processInfo.environment
      guard let path = environment["SHELLBELL_SHOWCASE"],
        let data = FileManager.default.contents(atPath: path),
        let decoded = try? JSONDecoder().decode([String: JSONValue].self, from: data)
      else { return nil }
      return Showcase(
        replies: decoded, show: environment["SHELLBELL_SHOWCASE_SHOW"] ?? "Settings",
        ready: environment["SHELLBELL_SHOWCASE_READY"],
        keepAwake: environment["SHELLBELL_SHOWCASE_KEEP_AWAKE"] == "1",
        height: environment["SHELLBELL_SHOWCASE_HEIGHT"].flatMap(Double.init) ?? 640)
    }
  }
#endif
