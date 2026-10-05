import Foundation
import ShellbellCore

@objc public protocol PowerHelperXPC {
  func request(_ data: Data, reply: @escaping (Data) -> Void)
}

/// XPC reply blocks may be invoked from the actor that owns the lease engine.
/// This immutable box transfers the block once; it never invokes it concurrently.
private final class PowerReplyBlock: @unchecked Sendable {
  let invoke: (Data) -> Void
  init(_ invoke: @escaping (Data) -> Void) { self.invoke = invoke }
}

/// One exported object per authenticated connection. Mutable admission state is
/// lock-protected; all lease state remains isolated to MainActor.
public final class PowerXPCExport: NSObject, PowerHelperXPC, @unchecked Sendable {
  private let session: PowerRequestSession
  private let invalidate: @Sendable () -> Void
  private let lock = NSLock()
  private var busy = false
  private var closed = false

  public init(session: PowerRequestSession, invalidate: @escaping @Sendable () -> Void) {
    self.session = session
    self.invalidate = invalidate
  }

  public func request(_ data: Data, reply: @escaping (Data) -> Void) {
    let accepted = lock.withLock {
      guard !closed, !busy, data.count <= 8192 else { return false }
      busy = true
      return true
    }
    guard accepted else {
      close()
      reply(Data())
      return
    }
    let response = PowerReplyBlock(reply)
    Task { @MainActor [self] in
      defer { lock.withLock { busy = false } }
      guard !lock.withLock({ closed }) else {
        response.invoke(Data())
        return
      }
      do {
        let result = try session.handle(data)
        response.invoke(try JSONEncoder().encode(result))
      } catch {
        // Session decoding failures already attempt restoration. Retry during
        // connection teardown, retaining the journal if restoration still fails.
        close()
        response.invoke(Data())
      }
    }
  }

  public func close() {
    let first = lock.withLock {
      if closed { return false }
      closed = true
      return true
    }
    guard first else { return }
    invalidate()
    Task { @MainActor [session] in try? session.close() }
  }
}
