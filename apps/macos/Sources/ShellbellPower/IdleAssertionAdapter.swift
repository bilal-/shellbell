import Foundation
import IOKit.pwr_mgt
import ShellbellCore

@MainActor public final class IdleAssertionAdapter: IdleAssertionAdapterProtocol {
  public struct Failure: Error { public let code: IOReturn }
  public init() {}
  public func acquire(_ kind: IdleAssertionKind) throws -> UInt32 {
    var id = IOPMAssertionID(0)
    let type =
      kind == .system
      ? kIOPMAssertionTypePreventUserIdleSystemSleep : kIOPMAssertionTypePreventUserIdleDisplaySleep
    let result = IOPMAssertionCreateWithName(
      type as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
      "Shellbell remote access" as CFString, &id)
    guard result == kIOReturnSuccess else { throw Failure(code: result) }
    return id
  }
  public func release(_ id: UInt32) throws {
    let result = IOPMAssertionRelease(id)
    guard result == kIOReturnSuccess || result == kIOReturnNotFound else {
      throw Failure(code: result)
    }
  }
  public func isActive(_ id: UInt32, kind: IdleAssertionKind) throws -> Bool {
    guard let properties = IOPMAssertionCopyProperties(id)?.takeRetainedValue() as? [String: Any],
      properties[kIOPMAssertionTypeKey] as? String == (kind == .system
        ? kIOPMAssertionTypePreventUserIdleSystemSleep : kIOPMAssertionTypePreventUserIdleDisplaySleep),
      let level = properties[kIOPMAssertionLevelKey] as? NSNumber,
      CFGetTypeID(level) != CFBooleanGetTypeID(),
      [kIOPMAssertionLevelOff, kIOPMAssertionLevelOn].contains(level.intValue)
    else { throw Failure(code: kIOReturnError) }
    return level.intValue == kIOPMAssertionLevelOn
  }
}
