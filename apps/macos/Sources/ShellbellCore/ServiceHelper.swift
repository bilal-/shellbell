import Foundation

public enum ServiceHelper {
  public static func perform(
    _ verb: String, admit: () throws -> Void, status: () -> String,
    register: () throws -> Void, unregister: () throws -> Void
  ) -> JSONValue {
    func failure(_ code: String) -> JSONValue {
      .object(["v": .number(1), "ok": .bool(false), "error": .object(["code": .string(code)])])
    }
    guard ["status", "register", "unregister"].contains(verb) else {
      return failure("operation-failed")
    }
    do { try admit() } catch { return failure("invalid-bundle") }
    do {
      if verb == "register" { try register() }
      if verb == "unregister" { try unregister() }
      let observed = status()
      guard ["not-registered", "enabled", "requires-approval", "not-found"].contains(observed)
      else { return failure("unavailable") }
      return .object(["v": .number(1), "ok": .bool(true), "status": .string(observed)])
    } catch { return failure(status() == "requires-approval" ? "denied" : "operation-failed") }
  }
}
