import Darwin
import Foundation
import ShellbellCore
import ShellbellPower

// Reject arguments, non-root and invalid signatures before opening the root
// journal, reading system power state or accepting any client request.
do {
  try PowerHelperAdmission.validate(
    arguments: Array(CommandLine.arguments.dropFirst()), realUID: getuid(), effectiveUID: geteuid())
  _ = try PowerPeerVerifier.currentPublisher(role: .helper)
  let events = NativePowerHelperEvents()
  let clock = ContinuousClock()
  let origin = clock.now
  let engine = PowerLeaseEngine(
    adapter: SystemSleepOverride(), store: ProtectedPowerJournal(),
    now: {
      let elapsed = origin.duration(to: clock.now).components
      return Double(elapsed.seconds) + Double(elapsed.attoseconds) / 1e18
    },
    host: { events.readHost() })
  let listener = try PowerHelperListener(engine: engine)
  let runtime = PowerHelperRuntime(engine: engine, events: events)
  // Recovery is attempted before accepting connections. Failed recovery retains
  // durable evidence and is retried by the independent watchdog.
  runtime.start()
  let signals = [SIGTERM, SIGINT].map { number in
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler {
      MainActor.assumeIsolated {
        do {
          try runtime.stop()
          exit(0)
        } catch {
          FileHandle.standardError.write(
            Data("Shellbell power restoration requires recovery.\n".utf8))
          exit(1)
        }
      }
    }
    source.resume()
    return source
  }
  listener.resume()
  withExtendedLifetime((listener, runtime, signals)) { RunLoop.main.run() }
  exit(1)
} catch {
  FileHandle.standardError.write(
    Data("Shellbell power helper requires an approved signed root daemon.\n".utf8))
  exit(1)
}
