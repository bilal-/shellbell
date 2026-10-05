// Test-only adversarial caller. Never packaged with Shellbell. It deliberately
// omits the production client's self-signature check so rejection is tested at
// the real helper boundary. The sole request is read-only status.
import Foundation

@objc protocol PowerHelperXPC {
  func request(_ data: Data, reply: @escaping (Data) -> Void)
}

final class ProbeResult: @unchecked Sendable {
  enum Outcome { case accepted, rejected, invalid }
  private let lock = NSLock()
  private var outcome: Outcome?
  let ready = DispatchSemaphore(value: 0)
  func finish(_ value: Outcome) {
    let first = lock.withLock {
      guard outcome == nil else { return false }
      outcome = value
      return true
    }
    if first { ready.signal() }
  }
  var value: Outcome? { lock.withLock { outcome } }
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 2, arguments[0].utf8.count == 10,
  arguments[0].utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) }),
  ["accept", "reject"].contains(arguments[1])
else { exit(2) }
let result = ProbeResult()
let connection = NSXPCConnection(
  machServiceName: "sh.bilal.shellbell.power", options: .privileged)
connection.setCodeSigningRequirement(
  "anchor apple generic and identifier \"sh.bilal.shellbell.power\" and certificate leaf[subject.OU] = \"\(arguments[0])\""
)
connection.remoteObjectInterface = NSXPCInterface(with: PowerHelperXPC.self)
connection.invalidationHandler = { result.finish(.rejected) }
connection.interruptionHandler = { result.finish(.rejected) }
connection.resume()
guard
  let proxy = connection.remoteObjectProxyWithErrorHandler({ _ in result.finish(.rejected) })
    as? PowerHelperXPC
else { exit(2) }
proxy.request(Data(#"{"v":1,"requestID":1,"verb":"status"}"#.utf8)) { data in
  guard data.count <= 8192,
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    object["v"] as? Int == 1, object["requestID"] as? Int == 1,
    object["ok"] is Bool, object["state"] is String
  else {
    result.finish(.invalid)
    return
  }
  result.finish(.accepted)
}
guard result.ready.wait(timeout: .now() + 8) == .success else {
  connection.invalidate()
  fputs("Probe timed out; rejection is unproven.\n", stderr)
  exit(2)
}
let passed = arguments[1] == "accept" ? result.value == .accepted : result.value == .rejected
connection.invalidate()
exit(passed ? 0 : 1)
